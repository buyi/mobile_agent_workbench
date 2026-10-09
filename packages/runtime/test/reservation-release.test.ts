import { afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { digestOf, type ContextManifest } from "../../contracts/src"
import { OpenCodeCli, restrictedConfigBinding, type RestrictedConfig, type StartInput, type StoppedReservationAuthorization } from "../src"
import { createHash } from "node:crypto"

const hash = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`
const cleanup: Array<() => void | Promise<unknown>> = []
afterEach(async () => { for (const finish of cleanup.splice(0).reverse()) await finish() })
function fixture() {
  // Synthetic host-authorized terminal files, never a claim of OS UID proof.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopit-release-test-")))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, "workspace"); mkdirSync(workspace, { mode: 0o700 })
  const executable = join(root, "fixture-cli")
  const code = `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('1.18.35');process.exit(0)}if(process.argv.includes('--help')){console.log('--format --model');process.exit(0)}const text=await Bun.stdin.text();if(text==='hold')setInterval(()=>{},1000);else console.log('fixture exit');\n`
  writeFileSync(executable, code); chmodSync(executable, 0o700)
  const pin = { path: executable, digest: hash(code) }
  const restricted: RestrictedConfig = { readPaths: ["code.ts"], editPaths: ["code.ts"], agent: { name: "fixture", steps: 8 },
    model: { provider: "openai", model: "fixture", variant: "low" }, catalog: pin, oauthAccess: async () => { throw new Error("must not resolve credentials") },
    isolation: { runtimeDirectory: join(root, "runtime"), childIdentity: { uid: 420, gid: 420 }, identityRuntime: pin,
      admission: { scopeId: "current", generation: 2 }, launcher: { argvPrefix: [], wrapperPath: executable, wrapperDigest: pin.digest }, denyRead: [], proxyPort: 7897 } }
  const options = { executable, executableDigest: pin.digest, version: "1.18.35", stateDirectory: join(root, "state"), restricted }
  const adapter = new OpenCodeCli(options), handle = { attemptId: "old-attempt", operationId: "old-operation" }
  const budget = { deadlineAt: new Date(Date.now() + 30_000).toISOString(), repairIndex: 0, maxRepairs: 3 as const }, prompt = "fixture code only"
  const model = { provider: "openai", model: "fixture" }, permission = restrictedConfigBinding(restricted).permissionDigest
  const context: ContextManifest = { schemaVersion: "context/1", manifestId: "context-old", attemptId: handle.attemptId, createdAt: new Date().toISOString(),
    goal: { taskId: "task", goalRevision: 1, digest: digestOf("goal") }, policy: { ref: "policy://fixed", digest: digestOf("policy") },
    toolCapabilities: [], knowledgeRefs: [], historyRefs: [], budget: { wallMinutesRemaining: 1, repairCyclesRemaining: 3 }, effectiveConfig: [
      { kind: "instruction", ref: "input://frozen-goal", digest: digestOf(prompt) },
      { kind: "permission", ref: "config://restricted-permissions", digest: permission },
      { kind: "model", ref: "config://model", digest: digestOf(model) },
      { kind: "model", ref: "config://opencode-restricted", digest: digestOf("old scope/steps; deliberately different") },
      { kind: "instruction", ref: "config://execution-budget", digest: digestOf(budget) },
    ] }
  const input: StartInput = { prompt, context, executionBudget: budget, spec: { schemaVersion: "execution/1", executionId: "execution-old", attemptId: handle.attemptId,
    runtime: { name: "opencode", version: "1.18.35", sourceDigest: pin.digest }, model, workingDirectory: workspace,
    contextManifest: { ref: "artifact://context-old", digest: digestOf(context) }, policyRef: "policy://fixed", budget: { wallMinutes: 1, maxRetries: 0 }, outputContract: { artifactKinds: [] } } }
  const directory = join(options.stateDirectory, "attempts", handle.attemptId); mkdirSync(directory, { mode: 0o700 })
  const reservationPath = join(options.stateDirectory, "reservations", hash(workspace).slice(7) + ".json")
  const state: any = { schemaVersion: "runtime-local/1", handle, workingDirectory: workspace, requestDigest: "", status: "exited", exitCode: 0,
    logs: { stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false, pipesComplete: true, redactionPending: false }, events: [] }
  const authorization: StoppedReservationAuthorization = { schemaVersion: "runtime-stopped-authorization/1", nonce: "stop-authorization", stopProofDigest: digestOf("synthetic trusted stop proof"), workingDirectory: workspace, requestDigest: "" }
  const persist = () => {
    const requestDigest = digestOf({ input, operationId: handle.operationId })
    state.requestDigest = requestDigest; (authorization as any).requestDigest = requestDigest
    writeFileSync(join(directory, "state.json"), JSON.stringify(state))
    writeFileSync(join(directory, "input.json"), JSON.stringify(input))
    writeFileSync(join(options.stateDirectory, "operations", handle.operationId + ".json"), JSON.stringify({ handle, requestDigest }))
    writeFileSync(reservationPath, JSON.stringify({ handle, requestDigest, workingDirectory: workspace }))
  }
  persist()
  for (const name of ["stdout.log", "stderr.log"]) writeFileSync(join(directory, name), "retained diagnostic history")
  return { root, workspace, options, adapter, handle, input, state, authorization, directory, reservationPath, persist }
}

function denyAllInput(f: ReturnType<typeof fixture>, prompt = "exit"): StartInput {
  const context = { ...f.input.context, manifestId: "context-new", attemptId: "new-attempt", effectiveConfig: [
    { kind: "instruction" as const, ref: "input://prompt", digest: digestOf(prompt) },
    { kind: "permission" as const, ref: "config://permissions", digest: digestOf({ "*": "deny" }) },
    { kind: "model" as const, ref: "config://model", digest: digestOf(f.input.spec.model) },
  ] }
  return { prompt, context, spec: { ...f.input.spec, executionId: "execution-new", attemptId: "new-attempt",
    contextManifest: { ref: "artifact://context-new", digest: digestOf(context) } } }
}

test("exact stop authorization archives reservation and preserves every Attempt/operation byte; replay cannot remove a newer reservation", async () => {
  const f = fixture(), priorReservation = readFileSync(f.reservationPath)
  const paths = ["input.json", "state.json", "stdout.log", "stderr.log"].map((name) => join(f.directory, name))
  paths.push(join(f.options.stateDirectory, "operations", f.handle.operationId + ".json"))
  const originals = paths.map((path) => readFileSync(path))
  const ordinary = new OpenCodeCli({ ...f.options, restricted: undefined }), next = denyAllInput(f, "hold")
  expect(() => ordinary.start(next, "new-operation")).toThrow("quarantined reservation")
  const released = f.adapter.releaseStoppedReservation(f.handle, f.authorization)
  expect(released.alreadyReleased).toBe(false)
  expect(existsSync(f.reservationPath)).toBe(false)
  expect(readFileSync(released.archivePath)).toEqual(priorReservation)
  paths.forEach((path, index) => expect(readFileSync(path)).toEqual(originals[index]))
  const handle = ordinary.start(next, "new-operation")
  cleanup.push(() => ordinary.cancel(handle))
  const newerReservation = readFileSync(f.reservationPath)
  expect(new OpenCodeCli(f.options).releaseStoppedReservation(f.handle, f.authorization).alreadyReleased).toBe(true)
  expect(readFileSync(f.reservationPath)).toEqual(newerReservation)
  const currentAuth = { ...f.authorization, nonce: "new-stop", requestDigest: digestOf({ input: next, operationId: handle.operationId }) }
  expect(() => ordinary.releaseStoppedReservation(handle, currentAuth)).toThrow("local child is still live")
})

test("unknown status, contradictory identities and changed inputs never release", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.state.status = "running"; f.persist() },
    (f: ReturnType<typeof fixture>) => { f.state.status = "reserved"; f.persist() },
    (f: ReturnType<typeof fixture>) => { f.state.logs.pipesComplete = false; f.persist() },
    (f: ReturnType<typeof fixture>) => { f.state.persistenceErrors = [{ phase: "exit", message: "unavailable" }]; f.persist() },
    (f: ReturnType<typeof fixture>) => { writeFileSync(join(f.directory, "input.json"), JSON.stringify({ ...f.input, prompt: "changed" })) },
    (f: ReturnType<typeof fixture>) => { writeFileSync(f.reservationPath, JSON.stringify({ handle: f.handle, requestDigest: digestOf("other"), workingDirectory: f.workspace })) },
  ]) {
    const f = fixture(); change(f)
    expect(() => f.adapter.releaseStoppedReservation(f.handle, f.authorization)).toThrow()
    expect(existsSync(f.reservationPath)).toBe(true)
    expect(existsSync(join(f.options.stateDirectory, "reconciliations"))).toBe(false)
  }
})

test("external capabilities and widened permission inputs cannot use pure-code release", () => {
  for (const change of [
    (input: StartInput) => { (input.context.toolCapabilities as any[]).push({ name: "external", version: "1" }) },
    (input: StartInput) => { (input.spec as any).nativeSessionRef = "session://old" },
    (input: StartInput) => { (input.context.effectiveConfig[1] as any).digest = digestOf({ "*": "allow" }) },
  ]) {
    const f = fixture(); change(f.input)
    ;(f.input.spec.contextManifest as any).digest = digestOf(f.input.context); f.persist()
    expect(() => f.adapter.releaseStoppedReservation(f.handle, f.authorization)).toThrow()
    expect(existsSync(f.reservationPath)).toBe(true)
  }
  const f = fixture()
  expect(() => new OpenCodeCli({ ...f.options, restricted: undefined }).releaseStoppedReservation(f.handle, f.authorization)).toThrow("restricted pure-code")
})

test("exclusive admission, nonce conflict, archive tamper and restored old reservation fail closed", () => {
  const f = fixture(), lock = join(f.options.stateDirectory, "admission.lock")
  writeFileSync(lock, "another owner")
  expect(() => f.adapter.releaseStoppedReservation(f.handle, f.authorization)).toThrow()
  expect(readFileSync(lock, "utf8")).toBe("another owner"); unlinkSync(lock)
  const released = f.adapter.releaseStoppedReservation(f.handle, f.authorization)
  expect(() => f.adapter.releaseStoppedReservation(f.handle, { ...f.authorization, stopProofDigest: digestOf("different") })).toThrow("nonce reused")
  writeFileSync(f.reservationPath, readFileSync(released.archivePath))
  expect(() => f.adapter.releaseStoppedReservation(f.handle, f.authorization)).toThrow("reappeared")
  unlinkSync(f.reservationPath)
  writeFileSync(released.archivePath, "{}")
  expect(() => f.adapter.releaseStoppedReservation(f.handle, f.authorization)).toThrow("archived reconciliation")
})

test("durable authorization interrupted before atomic archival can complete only with identical evidence", () => {
  const f = fixture(), released = f.adapter.releaseStoppedReservation(f.handle, f.authorization)
  renameSync(released.archivePath, f.reservationPath)
  expect(f.adapter.releaseStoppedReservation(f.handle, f.authorization).alreadyReleased).toBe(false)
  expect(readFileSync(released.archivePath, "utf8")).toContain(f.handle.operationId)
})

test("symlinked state is refused and a completed spawn failure can be explicitly released", () => {
  const f = fixture(), statePath = join(f.directory, "state.json"), actual = join(f.root, "other-state.json")
  renameSync(statePath, actual); symlinkSync(actual, statePath)
  expect(() => f.adapter.releaseStoppedReservation(f.handle, f.authorization)).toThrow("symbolic")
  unlinkSync(statePath); renameSync(actual, statePath)
  f.state.status = "spawn_failed"; f.persist()
  expect(f.adapter.releaseStoppedReservation(f.handle, f.authorization).status).toBe("released")
})
