import { afterEach, expect, test } from "bun:test"
import { mkdirSync, readdirSync, renameSync } from "node:fs"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { digestOf } from "@loopit/contracts"
import { OpenCodeCli, type Handle, type StartInput } from "../../runtime/src"
import type { WorkerDispatch } from "../src"
import { cmd, exec, goal } from "./helpers"
import { setup, spawnCount, until, withWorker } from "./worker-fixture"

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn() })
const proof = digestOf("fixture verified stop: no OS proof claimed")
function unprivileged(input: StartInput): StartInput {
  const context = { ...input.context, effectiveConfig: [
    { kind: "instruction" as const, ref: "input://fixture", digest: digestOf(input.prompt) },
    { kind: "permission" as const, ref: "config://deny-all", digest: digestOf({ "*": "deny" }) },
    { kind: "model" as const, ref: "config://model", digest: digestOf(input.spec.model) },
  ] }
  return { ...input, context, spec: { ...input.spec, contextManifest: { ...input.spec.contextManifest, digest: digestOf(context) } } }
}
function fixture() {
  const f = setup(), handles: Handle[] = []
  let native = f.adapter
  const state = { failPrepare: false, denyProof: false, beforePrepare: undefined as undefined | (() => Promise<void>), prepares: 0,
    launch: { ...f.launch, wallMinutes: 2, restrictedBinding: { configDigest: digestOf("fixture-scope"), permissionDigest: digestOf("fixed permissions") },
      executionBudget: { deadlineAt: new Date(Date.now() + 90_000).toISOString(), repairIndex: 0, maxRepairs: 3 as const } } }
  const adapter: WorkerDispatch.Options["adapter"] = {
    prepareStart: async (input, operation) => { state.prepares++; if (state.failPrepare) throw new Error("fixture prepare failed"); await state.beforePrepare?.(); return native.prepareStart(unprivileged(input), operation) },
    startPrepared: (input, operation, prepared) => { const handle = native.startPrepared(unprivileged(input), operation, prepared); handles.push(handle); return handle },
    inspect: (handle) => native.inspect(handle), cancel: (handle, reason) => native.cancel(handle, reason), collect: (handle) => native.collect(handle),
  }
  const options: WorkerDispatch.Options = { adapter, launch: () => state.launch, verifyStopped: async (request) => {
    if (state.denyProof) throw new Error("fixture independent stop proof unavailable")
    return { schemaVersion: "verified-worker-stop/1", requestDigest: digestOf(request), handle: request.record.handle,
      stopProofDigest: request.authorization.stopProofDigest, scopeId: "fixture-stopped-scope", generation: 1,
      ...(request.mode === "resume" ? { runtimeReleaseDigest: (request.authorization as WorkerDispatch.ResumeAuthorization).runtimeReleaseDigest } : {}) }
  } }
  cleanup.push(async () => { for (const h of handles) await native.cancel(h) })
  // Test-only release of an ordinary deny-all fixture after observing its exit.
  // Production uses Runtime.releaseStoppedReservation + independent Supervisor;
  // neither is represented as an OS proof by this fixture helper.
  const releaseFixture = (handle: Handle) => {
    expect(native.inspect(handle).status).toBe("exited")
    const directory = join(f.cli.stateDirectory, "reservations"), archive = join(f.root, "fixture-release")
    mkdirSync(archive, { recursive: true })
    for (const file of readdirSync(directory)) renameSync(join(directory, file), join(archive, handle.attemptId + "-" + file))
    native = new OpenCodeCli(f.cli) // Real cold Runtime read, unknown live ownership.
    return digestOf({ fixtureOnly: true, handle })
  }
  return { ...f, state, adapter, options, releaseFixture }
}
const stopAuth = (record: WorkerDispatch.DispatchRecord, nonce = "stop-1") => ({ nonce, previousOperationId: record.handle.operationId, stopProofDigest: proof })
const resumeAuth = (record: WorkerDispatch.DispatchRecord, resumeCommandId: string, runtimeReleaseDigest: string, nonce = "resume-1") =>
  ({ ...stopAuth(record, nonce), resumeCommandId, runtimeReleaseDigest })
const startPause = (f: ReturnType<typeof fixture>, worker: WorkerDispatch.Interface, delivery: import("../src").Delivery.Interface) => Effect.gen(function* () {
  yield* exec(delivery, cmd.create({ goal: goal({ objective: "fixture hold" }) })); yield* exec(delivery, cmd.start(1, "run-1")); yield* worker.drain()
  yield* Effect.promise(() => until(() => spawnCount(f.launch.workingDirectory) === 1))
  yield* worker.inspect("run-1")
  yield* exec(delivery, cmd.pause((yield* delivery.getTask("task-1"))!.version, "run-1")); yield* worker.drain()
  const record = (yield* worker.get("run-1"))!
  yield* Effect.promise(() => until(() => f.adapter.inspect(record.handle).status === "exited"))
  expect((yield* delivery.getRun("run-1"))!.status).toBe("pausing")
  return record
})

test("pause/cancel reach terminal control facts only through verified stop; cold resume creates one new Attempt preserving history/budget", async () => {
  const f = fixture()
  let prior!: WorkerDispatch.DispatchRecord, auth!: WorkerDispatch.ResumeAuthorization
  await withWorker(f.file, f.options, (worker, delivery) => Effect.gen(function* () {
    prior = yield* startPause(f, worker, delivery)
    f.state.denyProof = true
    expect(Exit.isFailure(yield* worker.confirmStopped("run-1", stopAuth(prior)).pipe(Effect.exit))).toBe(true)
    expect((yield* delivery.getRun("run-1"))!.status).toBe("pausing")
    f.state.denyProof = false
    yield* worker.confirmStopped("run-1", stopAuth(prior))
    expect((yield* delivery.getRun("run-1"))!.status).toBe("paused")
    expect((yield* worker.controlHistory("run-1"))).toHaveLength(1)
  }))
  const release = f.releaseFixture(prior.handle)
  await withWorker(f.file, f.options, (worker, delivery) => Effect.gen(function* () {
    expect((yield* delivery.getRun("run-1"))!.status).toBe("paused")
    expect(f.adapter.inspect(prior.handle).ownership).toBe("unknown")
    expect(Exit.isFailure(yield* worker.resumeStopped("run-1", resumeAuth(prior, "invented", release)).pipe(Effect.exit))).toBe(true)
    expect(spawnCount(f.launch.workingDirectory)).toBe(1)
    const command = cmd.resume((yield* delivery.getTask("task-1"))!.version, "run-1")
    yield* exec(delivery, command)
    auth = resumeAuth(prior, command.commandId, release)
    const results = yield* Effect.all(Array.from({ length: 4 }, () => worker.resumeStopped("run-1", auth)), { concurrency: "unbounded" })
    const next = (yield* worker.get("run-1"))!
    expect(results.every((r) => r.record?.handle.operationId === next.handle.operationId)).toBe(true)
    yield* Effect.promise(() => until(() => spawnCount(f.launch.workingDirectory) === 2)); yield* worker.inspect("run-1")
    expect((yield* delivery.getRun("run-1"))!.status).toBe("running")
    expect(next.handle).not.toEqual(prior.handle)
    expect(next.input!.executionBudget).toEqual(prior.input!.executionBudget)
    expect(next.input!.context.manifestId).not.toBe(prior.input!.context.manifestId)
    expect(next.input!.spec.executionId).not.toBe(prior.input!.spec.executionId)
    const history = yield* worker.controlHistory("run-1")
    expect(history).toHaveLength(2)
    expect(history.find((x) => x.kind === "resume")!.priorRecord.handle).toEqual(prior.handle)
    const { db } = yield* Database.Service
    expect(Exit.isFailure(yield* db.run(sql`DELETE FROM loopit_worker_control_recovery`).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* db.run(sql`UPDATE loopit_worker_control_recovery SET record='{}'`).pipe(Effect.exit))).toBe(true)
    yield* exec(delivery, cmd.cancel((yield* delivery.getTask("task-1"))!.version, "run-1")); yield* worker.drain()
    expect((yield* delivery.getRun("run-1"))!.status).toBe("cancelling")
    expect(Exit.isFailure(yield* worker.confirmStopped("run-1", { ...stopAuth(prior), nonce: "wrong-attempt" }).pipe(Effect.exit))).toBe(true)
    yield* worker.confirmStopped("run-1", stopAuth((yield* worker.get("run-1"))!, "cancel-stop"))
    expect((yield* delivery.getRun("run-1"))!.status).toBe("cancelled")
  }))
  await withWorker(f.file, f.options, (worker, delivery) => Effect.gen(function* () {
    expect((yield* delivery.getRun("run-1"))!.status).toBe("cancelled")
    expect((yield* worker.resumeStopped("run-1", auth)).kind).toBe("blocked")
    expect(spawnCount(f.launch.workingDirectory)).toBe(2)
  }))
}, 20_000)

test("missing/forged stop port, unknown observation, malformed digests and missing resume event never authorize a writer", async () => {
  const f = fixture()
  const prior = await withWorker(f.file, f.options, (worker, delivery) => startPause(f, worker, delivery))
  for (const options of [ { ...f.options, verifyStopped: undefined },
    { ...f.options, verifyStopped: async (r: WorkerDispatch.VerifyStoppedInput) => ({ ...(await f.options.verifyStopped!(r)), handle: { ...r.record.handle, operationId: "other" } }) },
    { ...f.options, adapter: { ...f.adapter, inspect: () => { throw new Error("receipt missing") } } },
  ]) await withWorker(f.file, options, (worker, delivery) => Effect.gen(function* () {
    expect(Exit.isFailure(yield* worker.confirmStopped("run-1", stopAuth(prior)).pipe(Effect.exit))).toBe(true)
    expect((yield* delivery.getRun("run-1"))!.status).toBe("pausing")
  }))
  await withWorker(f.file, f.options, (worker) => Effect.gen(function* () {
    expect(Exit.isFailure(yield* worker.confirmStopped("run-1", { ...stopAuth(prior), stopProofDigest: "fake" }).pipe(Effect.exit))).toBe(true)
    expect(yield* worker.controlHistory("run-1")).toHaveLength(0)
    expect(spawnCount(f.launch.workingDirectory)).toBe(1)
  }))
}, 15_000)

test.each(["cancel-race", "prepare-failure", "budget-reset"] as const)("%s fails closed; authorization cannot become a cold redispatch", async (mode) => {
  const f = fixture()
  let prior!: WorkerDispatch.DispatchRecord, auth!: WorkerDispatch.ResumeAuthorization
  await withWorker(f.file, f.options, (worker, delivery) => Effect.gen(function* () {
    prior = yield* startPause(f, worker, delivery); yield* worker.confirmStopped("run-1", stopAuth(prior))
    const release = f.releaseFixture(prior.handle), command = cmd.resume((yield* delivery.getTask("task-1"))!.version, "run-1")
    yield* exec(delivery, command); auth = resumeAuth(prior, command.commandId, release)
    if (mode === "prepare-failure") f.state.failPrepare = true
    if (mode === "budget-reset") f.state.launch.executionBudget = { ...f.state.launch.executionBudget, deadlineAt: new Date(Date.now() + 120_000).toISOString() }
    if (mode === "cancel-race") f.state.beforePrepare = async () => {
      await Effect.runPromise(exec(delivery, cmd.cancel((await Effect.runPromise(delivery.getTask("task-1")))!.version, "run-1")))
    }
    const result = yield* worker.resumeStopped("run-1", auth).pipe(Effect.exit)
    if (mode === "budget-reset") { expect(Exit.isFailure(result)).toBe(true); expect((yield* worker.controlHistory("run-1"))).toHaveLength(1) }
    else { expect(Exit.isSuccess(result)).toBe(true); expect((yield* worker.get("run-1"))!.phase).toBe(mode === "prepare-failure" ? "quarantined" : "suppressed") }
    expect(spawnCount(f.launch.workingDirectory)).toBe(1)
  }))
  await withWorker(f.file, f.options, (worker) => Effect.gen(function* () {
    if (mode !== "budget-reset") expect((yield* worker.resumeStopped("run-1", auth)).kind).toBe("blocked")
    expect(Exit.isFailure(yield* worker.resumeStopped("run-1", { ...auth, runtimeReleaseDigest: digestOf("different") }).pipe(Effect.exit))).toBe(true)
    expect(spawnCount(f.launch.workingDirectory)).toBe(1)
  }))
}, 15_000)
