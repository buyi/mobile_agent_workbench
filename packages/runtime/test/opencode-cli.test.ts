import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { digestOf, autonomousGaps, type ContextManifest, type ExecutionSpec } from "../../contracts/src"
import { OpenCodeCli, type Handle, type StartInput } from "../src"

const sha = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`
const temporary = () => mkdtempSync(join(tmpdir(), "loopit-runtime-"))
const fixture = `#!${process.execPath}
import { spawn } from "node:child_process";
if (process.argv.includes("--version")) { console.log("1.18.35"); process.exit(0) }
if (process.argv.includes("--help")) { console.log("--model --format"); process.exit(0) }
const input = await Bun.stdin.text();
console.log(JSON.stringify({ type:"fixture", input, home:process.env.HOME, args:process.argv.slice(2), inherited:process.env.OPENAI_API_KEY,
  projectConfig:process.env.OPENCODE_DISABLE_PROJECT_CONFIG, externalSkills:process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS,
  claudeCode:process.env.OPENCODE_DISABLE_CLAUDE_CODE, config:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) }));
if (input === "flood") console.log("x".repeat(20000));
if (input === "hold-tree" || input === "orphan-pipes") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", 1, 2] });
  console.log(JSON.stringify({ descendant:child.pid }));
  if (input === "orphan-pipes") process.exit(0);
}
if (input === "hold" || input === "hold-tree" || input === "tick") {
  process.on("SIGTERM", () => {});
  setInterval(() => { if(input === "tick") console.log(JSON.stringify({ tick:true })) }, 20);
} else process.exit(0);
`

function setup(logLimitBytes = 4096) {
  const root = temporary()
  const executable = join(root, "opencode-fixture")
  writeFileSync(executable, fixture)
  chmodSync(executable, 0o700)
  const options = { executable, executableDigest: sha(fixture), version: "1.18.35", stateDirectory: join(root, "worker"), logLimitBytes }
  return { root, options, adapter: new OpenCodeCli(options) }
}
function input(prompt = "exit", attemptId = "attempt-1", workingDirectory = temporary()): StartInput {
  const model = { provider: "fixture", model: "unbilled" }
  const context: ContextManifest = {
    schemaVersion: "context/1", manifestId: "context-1", attemptId, createdAt: new Date().toISOString(),
    goal: { taskId: "task-1", goalRevision: 1, digest: sha("goal") },
    policy: { ref: "policy://deny-all/v1", digest: sha("policy") }, toolCapabilities: [],
    effectiveConfig: [
      { kind: "instruction", ref: "input://prompt", digest: digestOf(prompt) },
      { kind: "model", ref: "config://model", digest: digestOf(model) },
      { kind: "permission", ref: "config://permissions", digest: digestOf({ "*": "deny" }) },
    ],
    knowledgeRefs: [], historyRefs: [], budget: { wallMinutesRemaining: 1, repairCyclesRemaining: 0 },
  }
  const spec: ExecutionSpec = {
    schemaVersion: "execution/1", executionId: "execution-1", attemptId, runtime: { name: "opencode", version: "1.18.35" }, model,
    workingDirectory, contextManifest: { ref: "artifact://context-1", digest: digestOf(context) }, policyRef: context.policy.ref,
    budget: { wallMinutes: 1, maxRetries: 0 }, outputContract: { artifactKinds: [] },
  }
  return { spec, context, prompt }
}
async function until(check: () => boolean, limit = 3000) {
  const deadline = Date.now() + limit
  while (!check()) { if (Date.now() > deadline) throw new Error("condition timed out"); await Bun.sleep(20) }
}
const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function start(adapter: OpenCodeCli, request: StartInput, operationId = "operation-1") {
  const handle = adapter.start(request, operationId)
  cleanups.push(() => adapter.cancel(handle))
  return handle
}
function stdout(adapter: OpenCodeCli, handle: Handle) {
  return readFileSync(adapter.collect(handle).artifacts.find((artifact) => artifact.path.endsWith("stdout.log"))!.path, "utf8")
}

describe("fixture CLI lifecycle (no model calls)", () => {
  test("preparation diagnostics identify fixed stage and exit status without input or probe output", async () => {
    const { options } = setup(), secret = "synthetic-private-diagnostic-payload"
    for (const [operation, body, expected] of [
      ["version-exit", `console.error(${JSON.stringify(secret)});process.exit(7)`, { exitCode: 7, signal: null }],
      ["version-signal", `console.error(${JSON.stringify(secret)});process.kill(process.pid,'SIGTERM')`, { exitCode: null, signal: "SIGTERM" }],
    ] as const) {
      const executable = `#!${process.execPath}\n${body}\n`
      writeFileSync(options.executable, executable)
      const adapter = new OpenCodeCli({ ...options, executableDigest: sha(executable) })
      await expect(adapter.prepareStart(input(secret), operation)).rejects.toThrow("CLI preparation probe failed")
      const path = join(options.stateDirectory, "probe", `preparation-${operation}.json`), bytes = readFileSync(path, "utf8")
      const report = JSON.parse(bytes)
      expect(report.stage).toBe("version")
      expect(report.failure.probe).toEqual({ reason: "exit_failure", ...expected })
      expect(bytes).not.toContain(secret)
      expect(bytes).not.toContain("OPENCODE_CONFIG_CONTENT")
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  })

  test("pin diagnostic is fixed and evidence write failure never replaces the original preparation failure", async () => {
    const { adapter, options } = setup()
    writeFileSync(options.executable, fixture + "\n// tampered")
    await expect(adapter.prepareStart(input(), "bad-pin")).rejects.toThrow("executable digest mismatch")
    const report = JSON.parse(readFileSync(join(options.stateDirectory, "probe", "preparation-bad-pin.json"), "utf8"))
    expect(report.stage).toBe("pin")
    expect(report.failure.message).toBe("executable digest mismatch")
    mkdirSync(join(options.stateDirectory, "probe", `preparation-disk-error.json.tmp-${process.pid}`))
    await expect(adapter.prepareStart(input(), "disk-error")).rejects.toThrow("executable digest mismatch")
    expect(existsSync(join(options.stateDirectory, "probe", "preparation-disk-error.json"))).toBe(false)
  })

  test("prepared starts reject forged, reused, cross-instance, changed-input and changed-binary receipts", async () => {
    const { adapter, options } = setup(), request = input("exit")
    const token = await adapter.prepareStart(request, "prepared-operation")
    expect(() => adapter.startPrepared(request, "prepared-operation", { kind: "runtime-local-prepared" })).toThrow("preparation identity")
    expect(() => new OpenCodeCli(options).startPrepared(request, "prepared-operation", token)).toThrow("preparation identity")
    expect(() => adapter.startPrepared({ ...request, prompt: "changed" }, "prepared-operation", token)).toThrow("preparation identity")
    expect(() => adapter.startPrepared(request, "another-operation", token)).toThrow("preparation identity")
    const handle = adapter.startPrepared(request, "prepared-operation", token)
    cleanups.push(() => adapter.cancel(handle))
    expect(() => adapter.startPrepared(request, "prepared-operation", token)).toThrow("preparation identity")

    const second = setup(), secondInput = input("exit"), secondToken = await second.adapter.prepareStart(secondInput, "binary-operation")
    writeFileSync(second.options.executable, fixture + "\n// replaced after preparation")
    expect(() => second.adapter.startPrepared(secondInput, "binary-operation", secondToken)).toThrow("digest mismatch")
    writeFileSync(second.options.executable, fixture)
    expect(() => second.adapter.startPrepared(secondInput, "binary-operation", secondToken)).toThrow("preparation identity")
  })

  test("pins executable hash and version; capability claims remain outside autonomous eligibility", () => {
    const { adapter, options } = setup()
    expect(autonomousGaps(adapter.probe())).toContain("processTreeControl")
    expect(() => new OpenCodeCli({ ...options, version: "other" }).probe()).toThrow("version mismatch")
    writeFileSync(options.executable, fixture + "\n// changed")
    expect(() => adapter.probe()).toThrow("digest mismatch")
  })

  test("isolates environment, binds context, deduplicates dispatch and separates exit from Gate", async () => {
    const { adapter, options } = setup()
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "must-not-inherit"
    cleanups.push(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous })
    const request = input()
    const handle = start(adapter, request)
    expect(adapter.start(request, handle.operationId)).toEqual(handle)
    await until(() => adapter.inspect(handle).status === "exited")
    const observed = adapter.collect(handle)
    expect(observed.gate).toBe("not_evaluated")
    expect(observed.observed.exitCode).toBe(0)
    expect(observed.observed.safeToRedispatch).toBe(false)
    const payload = JSON.parse(stdout(adapter, handle).trim())
    expect(payload.inherited).toBeUndefined()
    expect(payload.home).toStartWith(realpathSync(options.stateDirectory))
    expect(payload.projectConfig).toBe("1")
    expect(payload.externalSkills).toBe("1")
    expect(payload.claudeCode).toBe("1")
    expect(payload.config.permission).toEqual({ "*": "deny" })
    expect(payload.args).toEqual(["--pure", "run", "--format", "json", "--model", "fixture/unbilled"])
    const events = []
    for await (const event of adapter.observe(handle)) events.push(event)
    expect(events.map((event) => event.type)).toEqual(["started", "exited"])
    expect(adapter.sendInput().supported).toBe(false)
    expect(adapter.checkpoint().supported).toBe(false)
    expect(() => adapter.start({ ...request, prompt: "altered" }, handle.operationId)).toThrow("effective config")
  })

  test("pause terminates a resistant parent and its group, retaining the workspace quarantine", async () => {
    const { adapter } = setup()
    const request = input("hold-tree")
    const handle = start(adapter, request)
    await until(() => stdout(adapter, handle).includes("descendant"))
    const result = await adapter.cancel(handle, "pause")
    expect(result.observed.status).toBe("exited")
    expect(result.observed.processGroup).toBe("absent")
    expect(result.observed.stoppedAttempt).toBe("interrupted_for_pause")
    expect(result.observed.safeToRedispatch).toBe(false)
    expect(() => adapter.start(input("exit", "attempt-2", request.spec.workingDirectory), "operation-2")).toThrow()
    expect((await adapter.dispose(handle)).reservationRetained).toBe(true)
  })

  test("a new adapter cannot signal recovered PIDs or redispatch unknown attempts", async () => {
    const { adapter, options } = setup()
    const request = input("hold")
    const handle = start(adapter, request)
    await until(() => adapter.inspect(handle).status === "running")
    const reopened = new OpenCodeCli(options)
    expect(reopened.start(request, handle.operationId)).toEqual(handle)
    expect(reopened.inspect(handle).ownership).toBe("unknown")
    expect(reopened.reconcile(handle).decision).toBe("quarantine")
    expect((await reopened.cancel(handle)).requested).toBe(false)
    expect(adapter.inspect(handle).status).toBe("running")
    expect(() => reopened.start(input("exit", "attempt-2", request.spec.workingDirectory), "operation-2")).toThrow()
  })

  test("an operation ID cannot dispatch a second Attempt in another workspace", async () => {
    const { adapter } = setup()
    const handle = start(adapter, input())
    await until(() => adapter.inspect(handle).status === "exited")
    expect(() => adapter.start(input("exit", "attempt-2"), "operation-1")).toThrow()
  })

  test("an exited leader with living descendants retains the concurrency slot across workspaces and reopen", async () => {
    const { adapter, options } = setup()
    const request = input("orphan-pipes")
    const handle = start(adapter, request)
    await until(() => adapter.inspect(handle).status === "exited")
    const descendant = stdout(adapter, handle).split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((line) => line.descendant).descendant
    cleanups.push(() => { try { process.kill(descendant, "SIGKILL") } catch {} })
    expect(() => process.kill(descendant, 0)).not.toThrow()
    expect(adapter.inspect(handle).processGroup).toBe("alive")
    expect(() => start(adapter, input("hold", "attempt-2"), "operation-2")).toThrow("concurrency slot")
    const reopened = new OpenCodeCli(options)
    expect(reopened.start(request, handle.operationId)).toEqual(handle)
    expect(() => reopened.start(input("exit", "attempt-3"), "operation-3")).toThrow("concurrency slot")
  })

  test("even an absent process group cannot release a reservation without independent safety reconciliation", async () => {
    const { adapter, options } = setup()
    const handle = start(adapter, input())
    await until(() => adapter.inspect(handle).status === "exited" && adapter.inspect(handle).processGroup === "absent")
    expect(() => adapter.start(input("exit", "attempt-2"), "operation-2")).toThrow("concurrency slot")
    expect(() => new OpenCodeCli(options).start(input("exit", "attempt-2"), "operation-2")).toThrow("concurrency slot")
  })

  test("concurrency is limited across Adapter instances, including an unknown active owner", async () => {
    const { adapter, options } = setup()
    const handle = start(adapter, input("hold"))
    await until(() => adapter.inspect(handle).status === "running")
    expect(() => adapter.start(input("exit", "attempt-2"), "operation-2")).toThrow("concurrency limit")
    expect(() => new OpenCodeCli(options).start(input("exit", "attempt-2"), "operation-2")).toThrow("concurrency slot")
  })

  test("parent and child workspaces conflict even after the prior leader exits", async () => {
    for (const reverse of [false, true]) {
      const { adapter } = setup()
      const parent = temporary()
      const child = join(parent, "child")
      mkdirSync(child)
      const handle = start(adapter, input("exit", "attempt-1", reverse ? child : parent))
      await until(() => adapter.inspect(handle).status === "exited")
      expect(() => adapter.start(input("exit", "attempt-2", reverse ? parent : child), "operation-2")).toThrow("overlaps")
    }
  })

  test("state and workspace cannot contain one another in either direction", () => {
    const { adapter, root, options } = setup()
    const insideState = join(options.stateDirectory, "candidate")
    mkdirSync(insideState)
    for (const workspace of [root, insideState, "/"])
      expect(() => adapter.start(input("exit", "attempt-1", workspace), "operation-1")).toThrow("must not contain")
  })

  test("an admission lock left before a PID receipt blocks dispatch without guessing recovery", () => {
    const { adapter, options } = setup()
    writeFileSync(join(options.stateDirectory, "admission.lock"), "")
    expect(() => adapter.start(input(), "operation-1")).toThrow()
    expect(existsSync(join(options.stateDirectory, "admission.lock"))).toBe(true)
  })

  test("known local emergency stop succeeds despite unreadable state and a failed state write", async () => {
    const { adapter, options } = setup()
    const handle = start(adapter, input("hold-tree"))
    await until(() => stdout(adapter, handle).includes("descendant"))
    await expect(adapter.cancel({ ...handle, operationId: "wrong-operation" })).rejects.toThrow("identity mismatch")
    expect(adapter.inspect(handle).status).toBe("running")
    const state = join(options.stateDirectory, "attempts", handle.attemptId, "state.json")
    const blocker = `${state}.tmp-${process.pid}`
    renameSync(state, `${state}.saved`)
    mkdirSync(blocker)
    try {
      const result = await adapter.cancel(handle)
      expect(result.requested).toBe(true)
      expect(result.observed.status).toBe("exited")
      expect(result.observed.processGroup).toBe("absent")
      expect(result.observed.evidence.available).toBe(false)
      expect(result.observed.persistenceErrors.some((error) => error.phase === "stop_intent" && error.message.includes("EISDIR"))).toBe(true)
      const collected = adapter.collect(handle)
      expect(collected.gate).toBe("not_evaluated")
      expect(collected.observed.evidence.available).toBe(false)
      expect(collected.artifacts.find((artifact) => artifact.path.endsWith("state.json"))?.available).toBe(false)
      // exit/close and the grace-period callback must survive the same failure.
      await Bun.sleep(150)
      expect(adapter.inspect(handle).safeToRedispatch).toBe(false)
    } finally {
      rmdirSync(blocker)
      renameSync(`${state}.saved`, state)
    }
  })

  test("a log write failure stops the owned process without uncaught data/exit/close exceptions", async () => {
    const { adapter, options } = setup()
    const handle = start(adapter, input("tick"))
    await until(() => stdout(adapter, handle).includes('"tick"'))
    const log = join(options.stateDirectory, "attempts", handle.attemptId, "stdout.log")
    unlinkSync(log)
    mkdirSync(log)
    try {
      await until(() => adapter.inspect(handle).status === "exited")
      await Bun.sleep(150)
      const observed = adapter.inspect(handle)
      expect(observed.evidence.available).toBe(false)
      expect(observed.logs.stdoutTruncated).toBe(true)
      expect(observed.persistenceErrors.some((error) => error.phase === "log:stdout")).toBe(true)
      expect(observed.processGroup).toBe("absent")
      expect(adapter.collect(handle).artifacts.find((artifact) => artifact.path.endsWith("stdout.log"))?.available).toBe(false)
    } finally {
      rmdirSync(log)
    }
  })

  test("logs are bounded and truncation is explicit", async () => {
    const { adapter } = setup(1024)
    const handle = start(adapter, input("flood"))
    await until(() => adapter.inspect(handle).status === "exited")
    const collected = adapter.collect(handle)
    expect(collected.observed.logs.stdoutTruncated).toBe(true)
    expect(collected.observed.logs.stdoutBytes).toBeGreaterThan(20_000)
    expect(statSync(collected.artifacts.find((artifact) => artifact.path.endsWith("stdout.log"))!.path).size).toBe(1024)
  })

  test("collect is bounded when a descendant retains pipes after the leader exits", async () => {
    const { adapter } = setup()
    const handle = start(adapter, input("orphan-pipes"))
    await until(() => adapter.inspect(handle).status === "exited")
    const descendant = stdout(adapter, handle).split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((line) => line.descendant).descendant
    cleanups.push(() => { try { process.kill(descendant, "SIGKILL") } catch {} })
    const before = Date.now()
    expect(adapter.collect(handle).gate).toBe("not_evaluated")
    expect(Date.now() - before).toBeLessThan(100)
    await until(() => adapter.inspect(handle).logs.stdoutTruncated)
    expect(adapter.inspect(handle).logs.pipesComplete).toBe(false)
    expect((await adapter.cancel(handle)).requested).toBe(false)
    expect(adapter.reconcile(handle).decision).toBe("quarantine")
  })
})

const probeBinary = process.env.LOOPIT_OPENCODE_BINARY
test.skipIf(!probeBinary)("real pinned OpenCode CLI version/help probe only (no prompt or model)", () => {
  const executable = probeBinary!
  // A caller-provided digest pins expected bytes. Without one, this checks only
  // consistency of the local binary, not its release provenance.
  const executableDigest = process.env.LOOPIT_OPENCODE_EXECUTABLE_DIGEST ?? sha(readFileSync(executable))
  const adapter = new OpenCodeCli({ executable, executableDigest, version: "1.18.35", stateDirectory: temporary() })
  const capabilities = adapter.probe()
  expect(capabilities.runtime.version).toBe("1.18.35")
  expect(capabilities.structuredEvents.status).toBe("unverified")
  expect(capabilities.usageReporting.status).toBe("unverified")
})
