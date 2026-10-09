import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { digestOf } from "@loopit/contracts"
import { aggregateNativeUsage, createExperienceCandidate, recoverRunContext, type RecoveryArtifact, type RecoveryRequest, type RecoveryResult } from "../src/integration/context-recovery"
import { cmd, exec } from "./helpers"
import { setup, spawnCount, withWorker } from "./worker-fixture"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const now = "2026-10-09T12:00:00.000Z", observedAt = "2026-10-09T11:00:00.000Z", expiresAt = "2026-10-10T12:00:00.000Z"
const hash = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const step = (id = "prt_1", patch: Record<string, unknown> = {}) => ({ type: "step_finish", timestamp: 123,
  sessionID: "ses_fixture", part: { id, sessionID: "ses_fixture", messageID: "msg_1", type: "step-finish", reason: "stop", cost: 0,
    tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 20, write: 4 }, total: 39 }, ...patch } })
const ready = (result: RecoveryResult) => { expect(result.status, JSON.stringify(result.issues)).toBe("ready"); if (result.status !== "ready") throw new Error("blocked"); return result.snapshot }
const blocked = (result: RecoveryResult, code: string) => {
  expect(result.status).toBe("blocked"); expect(result.issues.map((issue) => issue.code)).toContain(code); expect(result).not.toHaveProperty("snapshot")
}
async function fixture() {
  const f = setup(); roots.push(f.root)
  // Persist a genuine committed outbox/input, then deliberately fail preparation.
  // No model or native child is launched; recovery must leave this unknown state alone.
  f.adapter.prepareStart = async () => { throw new Error("fixture: no process or model may start") }
  const options = { adapter: f.adapter, launch: () => f.launch }
  const record = await withWorker(f.file, options, (worker, delivery) => Effect.gen(function* () {
    yield* exec(delivery, cmd.create()); yield* exec(delivery, cmd.start(1, "run-1")); yield* worker.drain()
    return (yield* worker.get("run-1"))!
  }))
  expect(record.phase).toBe("quarantined"); expect(record.input).toBeDefined()
  const artifactRoot = join(f.root, "artifacts"); mkdirSync(artifactRoot)
  const artifacts: RecoveryArtifact[] = []
  const put = (name: string, role: RecoveryArtifact["role"], bytes: string) => {
    writeFileSync(join(artifactRoot, name), bytes)
    const artifact: RecoveryArtifact = { ref: `artifact://recovery/${name}`, path: name, role, digest: hash(bytes), taskId: "task-1", goalRevision: 1,
      runId: "run-1", attemptId: record.handle.attemptId, observedAt, expiresAt }
    const old = artifacts.findIndex((item) => item.ref === artifact.ref)
    if (old >= 0) artifacts[old] = artifact; else artifacts.push(artifact)
    return artifact
  }
  const candidate = put("candidate.patch", "candidate", "+ restored from persisted references\n")
  const evidence = put("observation.json", "evidence", JSON.stringify({ observed: "local fixture observation", trustedGate: false }))
  const log = put("native.jsonl", "log", [step(), step(), step("prt_2")].map((event) => JSON.stringify(event)).join("\n"))
  const request: RecoveryRequest = { runId: "run-1", artifactRoot, artifacts, candidateRef: candidate.ref, evidenceRefs: [evidence.ref], nativeUsageRefs: [log.ref], now }
  const recover = (input = request) => withWorker(f.file, options, (worker, delivery) => recoverRunContext({ delivery, dispatch: worker }, input))
  return { ...f, options, record, artifacts, put, candidate, evidence, log, request, recover }
}

describe("context recovery from committed records and actual artifact bytes", () => {
  test("reopens SQLite without a native session, bounds excerpts and preserves every original digest", async () => {
    const f = await fixture()
    const large = f.put("large.log", "log", "日志🙂".repeat(30_000))
    const snapshot = ready(await f.recover({ ...f.request, logRefs: [large.ref], maxExcerptBytes: 37, maxTotalExcerptBytes: 100 }))
    expect(snapshot.goal.taskId).toBe("task-1"); expect(snapshot.baseContext).toEqual(f.record.input!.context)
    expect(snapshot.dispatchDigest).toBe(digestOf(f.record)); expect(snapshot.candidate.digest).toBe(f.candidate.digest)
    expect(snapshot.artifacts.reduce((n, file) => n + file.excerptBytes, 0)).toBeLessThanOrEqual(100)
    expect(snapshot.artifacts.every((file) => file.excerptBytes <= 37 && Buffer.byteLength(file.excerpt) === file.excerptBytes)).toBe(true)
    const excerpt = snapshot.artifacts.find((file) => file.ref === large.ref)!
    expect(excerpt.digest).toBe(large.digest); expect(excerpt.bytes).toBeGreaterThan(100_000); expect(excerpt.truncated).toBe(true)
    expect(snapshot.usage.modelSteps).toBe(2)
    expect(snapshot.usage.tokens).toEqual({ input: 20, output: 4, reasoning: 6, cache: { read: 40, write: 8 } })
    expect(snapshot.usage.nativeReportedTotal?.sum).toBe(78)
    expect(snapshot.usage.nativeReportedCostUsd?.sum).toBe(0); expect(snapshot.usage.cost.known).toBe(false)
    expect(snapshot.usage.provenance[0]).toMatchObject({ ref: f.log.ref, digest: f.log.digest, uniqueSteps: 2, duplicates: 1 })
    expect(snapshot.usage.retries.providerInternal.known).toBe(false)
    expect(snapshot).toMatchObject({ nativeSessionUsed: false, resumeAuthorized: false, policyChanged: false, gate: "not_evaluated" })
    expect(spawnCount(f.launch.workingDirectory)).toBe(0)
    await withWorker(f.file, f.options, (worker, delivery) => Effect.gen(function* () {
      expect((yield* delivery.getRun("run-1"))!.status).toBe("queued")
      expect((yield* worker.get("run-1"))!.phase).toBe("quarantined")
    }))
  })

  test("rejects missing, tampered, expired, wrongly bound and escaping artifacts", async () => {
    const f = await fixture()
    blocked(await f.recover({ ...f.request, artifacts: f.artifacts.filter((item) => item.ref !== f.candidate.ref) }), "artifact_missing")
    writeFileSync(join(f.request.artifactRoot, f.candidate.path), "tampered")
    blocked(await f.recover(), "artifact_digest_mismatch")
    f.put(f.candidate.path, "candidate", "+ restored from persisted references\n")
    for (const patch of [{ expiresAt: observedAt }, { observedAt: expiresAt }])
      blocked(await f.recover({ ...f.request, artifacts: f.artifacts.map((item) => ({ ...item, ...patch })) }), "artifact_expired")
    for (const patch of [{ taskId: "wrong-task" }, { goalRevision: 2 }, { runId: "missing-run" }, { attemptId: "wrong-attempt" }])
      blocked(await f.recover({ ...f.request, artifacts: f.artifacts.map((item) => ({ ...item, ...patch })) }), "artifact_binding_mismatch")
    blocked(await f.recover({ ...f.request, artifacts: f.artifacts.map((item) => item.ref === f.candidate.ref ? { ...item, path: "../config.json" } : item) }), "artifact_unreadable")
    const outside = join(f.root, "outside.txt"); writeFileSync(outside, "+ restored from persisted references\n")
    unlinkSync(join(f.request.artifactRoot, f.candidate.path)); symlinkSync(outside, join(f.request.artifactRoot, f.candidate.path))
    blocked(await f.recover(), "artifact_unreadable")
    unlinkSync(join(f.request.artifactRoot, f.candidate.path))
    blocked(await f.recover(), "artifact_unreadable")
  })

  test("rejects a revised goal and mismatched or missing persisted ContextManifest material", async () => {
    const f = await fixture()
    await withWorker(f.file, f.options, (worker, delivery) => Effect.gen(function* () {
      for (const mode of ["goal", "material"] as const) {
        const dispatch = { get: (id: string) => worker.get(id).pipe(Effect.map((value) => {
          const copy = structuredClone(value)!
          const context = mode === "goal" ? { ...copy.input!.context, goal: { ...copy.input!.context.goal, digest: hash("wrong-goal") } } :
            { ...copy.input!.context, historyRefs: [{ ref: "artifact://missing-history", digest: hash("missing") }] }
          copy.input = { ...copy.input!, context, spec: { ...copy.input!.spec, contextManifest: { ...copy.input!.spec.contextManifest, digest: digestOf(context) } } }
          return copy
        })) }
        blocked(yield* recoverRunContext({ delivery, dispatch }, f.request), mode === "goal" ? "persisted_context_mismatch" : "artifact_missing")
      }
      expect((yield* exec(delivery, cmd.revise(2, 2))).status).toBe("accepted")
      blocked(yield* recoverRunContext({ delivery, dispatch: worker }, f.request), "persisted_context_mismatch")
    }))
  })

  test("formal Evidence receives its own goal/candidate checks, independent of trusted index metadata", async () => {
    const f = await fixture()
    const snapshot = ready(await f.recover())
    const evidence = { schemaVersion: "evidence/1", evidenceId: "ev-local", artifact: { artifactId: "artifact-local", digest: hash("payload") },
      issuer: { kind: "verifier", id: "verifier-local" }, criterionIds: [snapshot.goal.acceptance[0].id],
      goal: { taskId: "another-task", goalRevision: 1, acceptanceDigest: digestOf(snapshot.goal.acceptance) }, candidateDigest: hash("old-candidate"),
      environmentRevision: "test", toolVersion: "local/1", observedAt, observationWindow: { start: observedAt, end: observedAt }, result: "failed", limitations: [] }
    f.put(f.evidence.path, "evidence", JSON.stringify(evidence))
    const result = await f.recover()
    blocked(result, "evidence_wrong_goal"); blocked(result, "evidence_stale_candidate")
  })

  test("derives upper-layer retries from persisted Run lineage without treating model steps as provider retries", async () => {
    const f = await fixture()
    await withWorker(f.file, f.options, (worker, delivery) => Effect.gen(function* () {
      expect((yield* exec(delivery, cmd.report("run-1", "running"))).status).toBe("accepted")
      expect((yield* exec(delivery, cmd.report("run-1", "failed", { closeRevision: false }))).status).toBe("accepted")
      const task = (yield* delivery.getTask("task-1"))!
      expect((yield* exec(delivery, cmd.start(task.version, "run-2"))).status).toBe("accepted")
      yield* worker.drain()
      const snapshot = ready(yield* recoverRunContext({ delivery, dispatch: worker }, { ...f.request, runId: "run-2" }))
      expect(snapshot.usage.retries.upperLayer).toMatchObject({ count: 1, runIds: ["run-2", "run-1"] })
      expect(snapshot.usage.modelSteps).toBe(2); expect(snapshot.usage.retries.providerInternal.known).toBe(false)
    }))
  })

  test("records retrieval of versioned, scoped experience while rechecking original source bytes", async () => {
    const f = await fixture(), snapshot = ready(await f.recover())
    const experience = createExperienceCandidate(snapshot, { id: "experience-1", version: 1, summary: "Candidate observation, not an executable instruction", expiresAt })
    expect(experience.sourceSnapshotDigest).toBe(digestOf(snapshot))
    const artifact = f.put("experience.json", "experience", JSON.stringify(experience))
    const request = { ...f.request, experiences: [{ ref: artifact.ref, version: 1 }] }
    const retrieved = ready(await f.recover(request))
    expect(retrieved.experienceRetrievals[0]).toMatchObject({ ref: artifact.ref, version: 1, retrievedAt: now, applied: false })
    expect(retrieved.policyChanged).toBe(false)
    blocked(await f.recover({ ...request, experiences: [{ ref: artifact.ref, version: 2 }] }), "experience_invalid")
    f.put("experience.json", "experience", JSON.stringify({ ...experience, scope: { ...experience.scope, goalRevision: 2 } }))
    blocked(await f.recover(request), "experience_invalid")
    f.put("experience.json", "experience", JSON.stringify({ ...experience, expiresAt: observedAt }))
    blocked(await f.recover(request), "experience_invalid")
    f.put("experience.json", "experience", JSON.stringify(experience))
    writeFileSync(join(f.request.artifactRoot, f.log.path), "changed source")
    blocked(await f.recover(request), "experience_invalid")
  })

  test("a complete large structured artifact or malformed native usage blocks instead of silently skipping validation", async () => {
    const f = await fixture()
    f.put(f.evidence.path, "evidence", JSON.stringify({ text: "x".repeat(8 * 1024 * 1024) }))
    blocked(await f.recover(), "artifact_unreadable")
    f.put(f.evidence.path, "evidence", "valid plain text observation")
    f.put(f.log.path, "log", "\n\n{bad json}\n")
    const malformed = await f.recover()
    blocked(malformed, "native_usage_json_invalid")
    expect(malformed.issues.find((issue) => issue.code === "native_usage_json_invalid")!.message).toContain("line 3")
    f.put(f.log.path, "log", "x".repeat(1024 * 1024 + 1))
    blocked(await f.recover(), "native_usage_line_limit")
    f.put(f.log.path, "log", [step(), step("prt_1", { cost: 1 })].map((event) => JSON.stringify(event)).join("\n"))
    blocked(await f.recover(), "native_usage_conflict")
  })
})

describe("native step_finish parsing", () => {
  test("missing native cost stays unknown and duplicate part payloads must be identical", () => {
    const event = step(); delete (event.part as any).cost
    const lines = [event, { ...event, timestamp: 999 }].map((event, index) => ({ ref: "artifact://native", digest: hash("log"), line: index + 1, event }))
    const result = aggregateNativeUsage(lines, ["run-1"])
    expect(result.modelSteps).toBe(1); expect(result.nativeReportedCostUsd).toBeNull(); expect(result.cost.known).toBe(false)
    expect(result.nativeReportedTotal!.sum).toBe(39); expect(result.tokens!.input).toBe(10)
    const conflict = aggregateNativeUsage([...lines, { ...lines[0], event: step("prt_1", { tokens: { ...event.part.tokens, input: 11 } }) }], ["run-1"])
    expect(conflict.status).toBe("blocked"); expect(conflict.issues[0].code).toBe("native_usage_conflict")
    const reused = structuredClone(event); reused.sessionID = "ses_other"; reused.part.sessionID = "ses_other"
    expect(aggregateNativeUsage([...lines, { ...lines[0], event: reused }], ["run-1"]).status).toBe("blocked")
  })
  test("invalid counters cannot become zeros, and diagnostics stay bounded", () => {
    const malformed = { ref: "artifact://native", digest: hash("log"), line: 1, event: step("prt_1", { tokens: { input: -1 } }) }
    const result = aggregateNativeUsage(Array.from({ length: 1000 }, () => malformed), ["run-1"])
    expect(result.status).toBe("blocked"); expect(result.tokens).toBeNull(); expect(result.issues.length).toBeLessThanOrEqual(64)
    expect(aggregateNativeUsage([], ["run-1"]).status).toBe("unavailable")
  })
})
