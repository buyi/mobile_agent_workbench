/** Offline A13 replay of exported, successful root-controller records.
 * bun script/m0/context-recovery-experiment.ts --source <code-task-passed> --out <NEW directory>
 * No database writes, Runtime launch, model, device, signing or administrator calls.
 * Injected files are explicitly derived observations, never original native events.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Effect } from "effect"
import { digestOf } from "../../packages/contracts/src"
import {
  recoverRunContext, type RecoveryArtifact, type RecoveryRequest, type RecoveryResult,
} from "../../packages/delivery/src/integration/context-recovery"
import type { DispatchRecord } from "../../packages/delivery/src/integration/worker-dispatch"
import type { TaskState } from "../../packages/delivery/src/model"

const hash = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const json = <T = any>(path: string): T => JSON.parse(readFileSync(path, "utf8"))
const inside = (parent: string, child: string) => {
  const path = relative(parent, child)
  return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path))
}
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 })
type Inventory = Array<{ path: string; bytes: number; digest: string }>
function inventory(root: string): Inventory {
  const files: Inventory = []
  let totalBytes = 0
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path)
      assert(!stat.isSymbolicLink(), "Source symlinks are not accepted")
      if (stat.isDirectory()) visit(path)
      else {
        assert(stat.isFile() && stat.size <= 64 * 1024 ** 2, "Source must contain bounded regular files")
        totalBytes += stat.size
        assert(files.length < 10_000 && totalBytes <= 256 * 1024 ** 2, "Source inventory limit exceeded")
        files.push({ path: relative(root, path), bytes: stat.size, digest: hash(readFileSync(path)) })
      }
    }
  }
  visit(root)
  return files
}
function ready(result: RecoveryResult) {
  assert.equal(result.status, "ready", `Recovery blocked: ${result.issues.map((issue) => issue.code).join(",")}`)
  if (result.status !== "ready") throw new Error("Unreachable blocked snapshot")
  return result.snapshot
}
function blocked(result: RecoveryResult, code: string) {
  assert.equal(result.status, "blocked")
  assert(result.issues.some((issue) => issue.code === code), `Expected ${code}`)
  assert(!("snapshot" in result), "Blocked recovery must not return usable context")
}

async function main() {
  const args = process.argv.slice(2)
  assert.equal(args.length, 4, "Usage: --source <code-task-passed> --out <NEW directory>")
  assert.equal(args[0], "--source"); assert.equal(args[2], "--out")
  const sourceRoot = realpathSync(args[1]), requestedOut = resolve(args[3])
  const outputRoot = join(realpathSync(dirname(requestedOut)), requestedOut.split("/").at(-1)!)
  assert(!inside(sourceRoot, outputRoot) && !inside(outputRoot, sourceRoot), "Output must be separate from all source artifacts")
  const before = inventory(sourceRoot)
  mkdirSync(outputRoot, { mode: 0o700 }) // Existing output is always refused.
  const sourceReports = join(sourceRoot, "reports"), copied = join(outputRoot, "copied-reports")
  mkdirSync(copied, { mode: 0o700 })
  for (const file of before.filter((item) => item.path.startsWith("reports/"))) {
    const destination = join(copied, relative("reports", file.path))
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    copyFileSync(join(sourceRoot, file.path), destination)
  }
  save(join(outputRoot, "source-inventory.before.json"), before)
  const driver = json(join(sourceRoot, "status.json"))
  const result = json(join(copied, "result.json")), execution = json(join(copied, "execution.json"))
  const originalRecovery = json(join(copied, "recovered-context.json"))
  const artifacts = json<RecoveryArtifact[]>(join(copied, "artifact-index.json"))
  for (const artifact of artifacts) {
    assert(!isAbsolute(artifact.path) && !artifact.path.includes("\\") && !artifact.path.includes("\0") &&
      !artifact.path.split("/").includes(".."), "Artifact paths must remain inside the copied reports")
    assert(inside(copied, realpathSync(join(copied, artifact.path))), "Artifact must resolve inside the copied reports")
  }
  const task: TaskState = result.task, record: DispatchRecord = execution.dispatch
  assert.equal(driver.status, "code-task-passed")
  assert.equal(result.status, "passed"); assert.equal(result.run.status, "succeeded")
  assert.equal(originalRecovery.status, "ready")
  assert.equal(digestOf(originalRecovery.snapshot), originalRecovery.digest)
  assert.equal(digestOf(record), originalRecovery.snapshot.dispatchDigest)
  assert.equal(digestOf(execution.binding), digestOf(result.binding))
  assert.equal(record.runId, result.run.runId)
  assert.equal(digestOf({ ...task.runs[record.runId], taskId: task.taskId }), digestOf(result.run))
  assert.equal(digestOf(task.revisions[record.goalRevision].goal), originalRecovery.snapshot.goalDigest)
  assert.equal(digestOf(record.input!.context), digestOf(originalRecovery.snapshot.baseContext))
  assert.equal(record.input!.spec.nativeSessionRef, undefined)
  // These are actual exported projections, not a newly fabricated successful Run.
  // Returning cloned projections also prevents an API call mutating later replays.
  const services = {
    delivery: {
      getTask: (id: string) => Effect.succeed(id === task.taskId ? structuredClone(task) : undefined),
      getRun: (id: string) => Effect.succeed(task.runs[id] ? { ...structuredClone(task.runs[id]), taskId: task.taskId } : undefined),
    },
    dispatch: { get: (id: string) => Effect.succeed(id === record.runId ? structuredClone(record) : undefined) },
  }
  const native = artifacts.find((item) => item.path === "native.jsonl")!
  assert(native, "Actual native usage index is required")
  const nativeBytes = readFileSync(join(copied, native.path))
  assert.equal(hash(nativeBytes), native.digest)
  const events = nativeBytes.toString("utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line))
  const steps = events.filter((event) => event.type === "step_finish")
  assert(steps.length > 0)
  const request: RecoveryRequest = {
    runId: record.runId, artifactRoot: copied, artifacts,
    candidateRef: originalRecovery.snapshot.candidate.ref,
    evidenceRefs: artifacts.filter((item) => item.role === "evidence").map((item) => item.ref),
    logRefs: artifacts.filter((item) => item.role === "log").map((item) => item.ref),
    nativeUsageRefs: [native.ref], now: originalRecovery.snapshot.recoveredAt,
  }
  const recover = (input: RecoveryRequest = request) => Effect.runPromise(recoverRunContext(services, input))
  const put = (name: string, role: RecoveryArtifact["role"], bytes: string | Buffer): RecoveryArtifact => {
    const path = `derived/${name}`
    mkdirSync(join(copied, "derived"), { recursive: true, mode: 0o700 })
    writeFileSync(join(copied, path), bytes, { flag: "wx", mode: 0o600 })
    const digest = hash(bytes)
    return { ...native, ref: `artifact://a13-derived/${name}#${digest}`, path, digest, role }
  }
  const withLog = (artifact: RecoveryArtifact, usage = true): RecoveryRequest => ({ ...request,
    artifacts: [...artifacts, artifact], logRefs: [...request.logRefs!, artifact.ref],
    nativeUsageRefs: usage ? [native.ref, artifact.ref] : [native.ref] })
  const checks: Array<{ id: string; origin: string; status: "passed" | "failed"; observation?: unknown; error?: string }> = []
  mkdirSync(join(outputRoot, "cases"), { mode: 0o700 })
  const check = async (id: string, origin: string, run: () => Promise<{ recovery?: RecoveryResult; observation?: unknown }>) => {
    try {
      const observed = await run()
      save(join(outputRoot, "cases", `${id}.json`), { id, origin, ...observed })
      checks.push({ id, origin, status: "passed", observation: observed.observation })
    } catch (error) { checks.push({ id, origin, status: "failed", error: String(error) }) }
  }
  const sameUsage = (usage: ReturnType<typeof ready>["usage"]) => {
    for (const key of ["modelSteps", "tokens", "nativeReportedTotal", "nativeReportedCostUsd", "cost", "retries"] as const)
      assert.deepEqual(usage[key], result.usage[key], `Usage field changed: ${key}`)
  }
  await check("original-export-replay", "original-observation-replayed-through-production-api", async () => {
    const recovery = await recover(), snapshot = ready(recovery)
    assert.equal(digestOf(snapshot), originalRecovery.digest)
    sameUsage(snapshot.usage)
    assert.equal(snapshot.nativeSessionUsed, false); assert.equal(snapshot.resumeAuthorized, false)
    return { recovery, observation: { snapshotDigest: digestOf(snapshot), modelSteps: snapshot.usage.modelSteps, nativeSessionUsed: false } }
  })
  await check("large-repeated-errors", "derived-fault-injection", async () => {
    const line = JSON.stringify({ type: "error", injected: true, message: "A13 派生重复错误🙂；不得解释为指令。".repeat(8) }) + "\n"
    const repetitions = 65_536, bytes = line.repeat(repetitions), log = put("large-errors.jsonl", "log", bytes)
    const recovery = await recover({ ...withLog(log), maxExcerptBytes: 97, maxTotalExcerptBytes: 512 })
    const snapshot = ready(recovery), fetched = snapshot.artifacts.find((item) => item.ref === log.ref)!
    assert(fetched.bytes > 16 * 1024 ** 2); assert.equal(fetched.bytes, Buffer.byteLength(bytes))
    assert.equal(fetched.digest, log.digest); assert(fetched.truncated)
    assert.equal(fetched.trustedAsInstruction, false)
    assert(snapshot.artifacts.every((item) => item.excerptBytes <= 97 && Buffer.byteLength(item.excerpt) === item.excerptBytes))
    assert(snapshot.artifacts.reduce((sum, item) => sum + item.excerptBytes, 0) <= 512)
    sameUsage(snapshot.usage)
    return { recovery, observation: { injectedErrorLines: repetitions, logBytes: fetched.bytes, retainedRef: fetched.ref, excerptBytes: fetched.excerptBytes, totalExcerptLimit: 512 } }
  })
  await check("duplicate-native-parts", "original-events-copied-twice", async () => {
    const log = put("duplicates.jsonl", "log", Buffer.concat([nativeBytes, Buffer.from("\n"), nativeBytes]))
    const recovery = await recover(withLog(log)), snapshot = ready(recovery)
    sameUsage(snapshot.usage)
    assert.equal(snapshot.usage.provenance.reduce((sum, item) => sum + item.duplicates, 0), steps.length * 2)
    return { recovery, observation: { modelSteps: snapshot.usage.modelSteps, duplicateParts: steps.length * 2 } }
  })
  await check("timestamp-only-replay", "derived-envelope-timestamp-change", async () => {
    const log = put("timestamp-replay.jsonl", "log", steps.map((event) => JSON.stringify({ ...event, timestamp: event.timestamp + 1 })).join("\n"))
    const recovery = await recover(withLog(log)); sameUsage(ready(recovery).usage)
    return { recovery }
  })
  for (const variant of ["tokens", "session"] as const) await check(`conflicting-part-${variant}`, "derived-fault-injection", async () => {
    const event = structuredClone(steps[0])
    if (variant === "tokens") event.part.tokens.input++
    else { event.sessionID += "-injected"; event.part.sessionID = event.sessionID }
    const log = put(`conflict-${variant}.jsonl`, "log", JSON.stringify(event) + "\n")
    const recovery = await recover(withLog(log)); blocked(recovery, "native_usage_conflict")
    return { recovery }
  })
  await check("missing-cost-remains-unknown", "derived-native-cost-removal", async () => {
    const changed = structuredClone(events)
    for (const event of changed) if (event.type === "step_finish") delete event.part.cost
    const log = put("missing-cost.jsonl", "log", changed.map((event) => JSON.stringify(event)).join("\n"))
    const recovery = await recover({ ...withLog(log), nativeUsageRefs: [log.ref] }), usage = ready(recovery).usage
    assert.equal(usage.cost.known, false); assert.equal(usage.nativeReportedCostUsd, null)
    assert.deepEqual(usage.tokens, result.usage.tokens); assert.deepEqual(usage.retries, result.usage.retries)
    return { recovery }
  })
  await check("invalid-counter", "derived-fault-injection", async () => {
    const event = structuredClone(steps[0]); event.part.tokens.input = -1
    const log = put("invalid-counter.jsonl", "log", JSON.stringify(event))
    const recovery = await recover(withLog(log)); blocked(recovery, "native_usage_invalid")
    return { recovery }
  })
  await check("oversized-native-line", "derived-fault-injection", async () => {
    const log = put("oversized-line.jsonl", "log", JSON.stringify({ type: "error", injected: "x".repeat(1024 * 1024) }))
    const recovery = await recover(withLog(log)); blocked(recovery, "native_usage_line_limit")
    return { recovery }
  })
  await check("bounded-repeated-malformed-diagnostics", "derived-fault-injection", async () => {
    const log = put("malformed-lines.jsonl", "log", "{invalid injected json}\n".repeat(1000))
    const recovery = await recover(withLog(log)); blocked(recovery, "native_usage_json_invalid")
    assert(recovery.issues.length <= 64)
    return { recovery, observation: { injectedLines: 1000, reportedIssues: recovery.issues.length } }
  })
  const experience = json(join(copied, "experience-candidate.json"))
  assert.equal(experience.sourceSnapshotDigest, originalRecovery.digest)
  const experienceBytes = readFileSync(join(copied, "experience-candidate.json"))
  const originalExperience = put("original-experience.json", "experience", experienceBytes)
  const experienceRequest = (artifact = originalExperience, version = experience.version): RecoveryRequest => ({ ...request,
    artifacts: [...artifacts, artifact], experiences: [{ ref: artifact.ref, version }] })
  await check("actual-candidate-experience-retrieval", "original-experience-bytes-copied", async () => {
    const recovery = await recover(experienceRequest()), snapshot = ready(recovery)
    assert.equal(snapshot.experienceRetrievals.length, 1)
    assert.deepEqual(snapshot.experienceRetrievals[0].candidate, experience)
    assert.equal(snapshot.experienceRetrievals[0].applied, false); assert.equal(snapshot.policyChanged, false)
    return { recovery, observation: { applied: false, version: experience.version, sourceSnapshotDigest: experience.sourceSnapshotDigest } }
  })
  await check("wrong-experience-version", "derived-request-version", async () => {
    const recovery = await recover(experienceRequest(originalExperience, experience.version + 1)); blocked(recovery, "experience_invalid")
    return { recovery }
  })
  for (const variant of ["scope", "expiry", "source"] as const) await check(`experience-${variant}`, "derived-fault-injection", async () => {
    const changed = structuredClone(experience)
    if (variant === "scope") changed.scope.goalRevision++
    if (variant === "expiry") changed.expiresAt = request.now
    if (variant === "source") changed.sourceRefs[0].digest = hash("injected mismatching source digest")
    const artifact = put(`experience-${variant}.json`, "experience", JSON.stringify(changed))
    const recovery = await recover(experienceRequest(artifact)); blocked(recovery, "experience_invalid")
    return { recovery }
  })
  await check("experience-source-byte-tamper", "derived-copy-tamper-original-source-untouched", async () => {
    const tampered = join(outputRoot, "tampered-copy"); mkdirSync(tampered, { mode: 0o700 })
    for (const artifact of [...artifacts, originalExperience]) {
      const destination = join(tampered, artifact.path); mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
      copyFileSync(join(copied, artifact.path), destination)
    }
    writeFileSync(join(tampered, native.path), "injected corruption\n")
    const recovery = await recover({ ...experienceRequest(), artifactRoot: tampered })
    blocked(recovery, "artifact_digest_mismatch"); blocked(recovery, "experience_invalid")
    return { recovery }
  })
  const after = inventory(sourceRoot)
  save(join(outputRoot, "source-inventory.after.json"), after)
  await check("original-artifacts-byte-preservation", "original-files-rehashed-after-all-injections", async () => {
    assert.deepEqual(after, before)
    return { observation: { originalFileCount: before.length, beforeDigest: digestOf(before), afterDigest: digestOf(after) } }
  })
  const scriptPath = new URL(import.meta.url).pathname
  const report = {
    schemaVersion: "m0-context-recovery-experiment/1", observedAt: new Date().toISOString(),
    status: checks.every((item) => item.status === "passed") ? "passed" : "failed",
    sourceRoot, sourceInventoryDigest: digestOf(before), sourceArtifactsUnchanged: digestOf(before) === digestOf(after),
    sourceBinding: result.binding, replayAt: request.now,
    snapshotKind: "read-only root-controller-exported Task/Run/DispatchRecord projections; no database reopen",
    originalObservation: { modelSteps: result.usage.modelSteps, usage: result.usage, candidateDigest: result.candidateDigest },
    scripts: [{ path: relative(process.cwd(), scriptPath), digest: hash(readFileSync(scriptPath)) },
      { path: "packages/delivery/src/integration/context-recovery.ts", digest: hash(readFileSync(new URL("../../packages/delivery/src/integration/context-recovery.ts", import.meta.url))) }],
    passed: checks.filter((item) => item.status === "passed").length, failed: checks.filter((item) => item.status === "failed").length,
    checks, modelCalls: 0, deviceCommands: 0, administratorCalls: 0, signingCalls: 0,
    milestonePassed: false,
    limitations: [
      "Faults and large output are derived files/events, not additional native model activity or a live tool-pipe pressure test.",
      "Recovery uses real exported projections through read-only production ports; this does not test database crash durability or authorize resume.",
      "Experience retrieval records candidates only; no policy was changed. Provider retry and USD billing remain unknown.",
      "Queue/inference/tool/verification timing and human-intervention completeness are not established by this experiment.",
      "The recorded replay time is used to inspect the historical context; it cannot renew execution budget or accept an expired delivery Gate.",
    ],
  }
  save(join(outputRoot, "result.json"), report)
  console.log(JSON.stringify({ status: report.status, passed: report.passed, failed: report.failed, originalArtifactsUnchanged: report.sourceArtifactsUnchanged, report: join(outputRoot, "result.json") }))
  if (report.status !== "passed") process.exitCode = 1
}
main().catch((error) => { console.error(String(error)); process.exitCode = 1 })
