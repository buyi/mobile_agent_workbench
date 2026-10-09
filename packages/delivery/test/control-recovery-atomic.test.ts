import { afterEach, expect, test } from "bun:test"
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { digestOf } from "@loopit/contracts"
import { OpenCodeCli, type Handle, type StartInput } from "../../runtime/src"
import type { Delivery, WorkerDispatch } from "../src"
import type { TaskState } from "../src/model"
import { cmd, exec, goal } from "./helpers"
import { setup, spawnCount, until, withWorker } from "./worker-fixture"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
const proofDigest = digestOf("test-only trusted host seam; no OS proof asserted")
function fixture() {
  const f = setup(), handles: Handle[] = []
  let native = f.adapter
  const state = { denyProof: false, proofCalls: 0, prepares: 0, afterPrepare: undefined as (() => void) | undefined }
  const ordinary = (input: StartInput): StartInput => {
    const context = { ...input.context, effectiveConfig: [
      { kind: "instruction" as const, ref: "input://fixture", digest: digestOf(input.prompt) },
      { kind: "permission" as const, ref: "config://deny-all", digest: digestOf({ "*": "deny" }) },
      { kind: "model" as const, ref: "config://model", digest: digestOf(input.spec.model) },
    ] }
    return { ...input, context, spec: { ...input.spec, contextManifest: { ...input.spec.contextManifest, digest: digestOf(context) } } }
  }
  const adapter: WorkerDispatch.Options["adapter"] = {
    prepareStart: async (input, operation) => { state.prepares++; const receipt = await native.prepareStart(ordinary(input), operation); state.afterPrepare?.(); return receipt },
    startPrepared: (input, operation, prepared) => { const handle = native.startPrepared(ordinary(input), operation, prepared); handles.push(handle); return handle },
    inspect: handle => native.inspect(handle), cancel: (handle, reason) => native.cancel(handle, reason), collect: handle => native.collect(handle),
  }
  const options: WorkerDispatch.Options = { adapter,
    launch: () => ({ ...f.launch, wallMinutes: 2, restrictedBinding: { configDigest: digestOf("fixed host fixture"), permissionDigest: digestOf("fixed permission fixture") }, executionBudget: budget }),
    verifyStopped: async request => {
      state.proofCalls++
      if (state.denyProof) throw new Error("host proof withdrawn during preparation")
      return { schemaVersion: "verified-worker-stop/1", requestDigest: digestOf(request), handle: request.record.handle,
        stopProofDigest: request.authorization.stopProofDigest, scopeId: "fixture-scope", generation: 1,
        ...(request.mode === "resume" ? { runtimeReleaseDigest: (request.authorization as WorkerDispatch.ResumeAuthorization).runtimeReleaseDigest } : {}) }
    } }
  const budget = { deadlineAt: new Date(Date.now() + 90_000).toISOString(), repairIndex: 0, maxRepairs: 3 as const }
  const releaseFixture = (handle: Handle) => {
    // Ordinary fixture only. Its real child has exited; production uses the
    // separately tested Runtime reservation release and Supervisor proof pair.
    expect(native.inspect(handle).status).toBe("exited")
    const archive = join(f.root, "test-only-release"); mkdirSync(archive)
    for (const name of readdirSync(join(f.cli.stateDirectory, "reservations"))) renameSync(join(f.cli.stateDirectory, "reservations", name), join(archive, name))
    native = new OpenCodeCli(f.cli)
    return digestOf({ testOnly: true, handle })
  }
  cleanup.push(async () => { for (const handle of handles) await native.cancel(handle); rmSync(f.root, { recursive: true, force: true }) })
  return { ...f, options, adapter, state, releaseFixture, budget }
}
const stopAuth = (record: WorkerDispatch.DispatchRecord) => ({ nonce: "verified-stop", previousOperationId: record.handle.operationId, stopProofDigest: proofDigest })
function pausing(f: ReturnType<typeof fixture>, worker: WorkerDispatch.Interface, delivery: Delivery.Interface) {
  return Effect.gen(function* () {
    expect((yield* exec(delivery, cmd.create({ goal: goal({ objective: "fixture hold" }) }))).status).toBe("accepted")
    expect((yield* exec(delivery, cmd.start(1, "run-1"))).status).toBe("accepted")
    yield* worker.drain(); yield* Effect.promise(() => until(() => spawnCount(f.launch.workingDirectory) === 1))
    yield* worker.inspect("run-1")
    expect((yield* exec(delivery, cmd.pause((yield* delivery.getTask("task-1"))!.version, "run-1"))).status).toBe("accepted")
    yield* worker.drain()
    const prior = (yield* worker.get("run-1"))!
    yield* Effect.promise(() => until(() => f.adapter.inspect(prior.handle).status === "exited"))
    expect((yield* delivery.getRun("run-1"))!.status).toBe("pausing")
    return prior
  })
}

test("host proof revoked after real Runtime preparation prevents writer start and a cold authorization replay", async () => {
  const f = fixture()
  let authorization!: WorkerDispatch.ResumeAuthorization, storedOperation!: string
  await withWorker(f.file, f.options, (worker, delivery) => Effect.gen(function* () {
    const prior = yield* pausing(f, worker, delivery)
    yield* worker.confirmStopped("run-1", stopAuth(prior))
    const release = f.releaseFixture(prior.handle), command = cmd.resume((yield* delivery.getTask("task-1"))!.version, "run-1")
    expect((yield* exec(delivery, command)).status).toBe("accepted")
    authorization = { nonce: "resume-withdrawn-proof", previousOperationId: prior.handle.operationId, stopProofDigest: proofDigest,
      resumeCommandId: command.commandId, runtimeReleaseDigest: release }
    const before = { proofs: f.state.proofCalls, prepares: f.state.prepares }
    f.state.afterPrepare = () => { f.state.denyProof = true }
    const result = yield* worker.resumeStopped("run-1", authorization)
    expect(result.kind).toBe("blocked")
    expect(result.reason).toContain("resume stop authorization no longer valid")
    expect(f.state.proofCalls).toBe(before.proofs + 2)
    expect(f.state.prepares).toBe(before.prepares + 1)
    expect(spawnCount(f.launch.workingDirectory)).toBe(1)
    const record = (yield* worker.get("run-1"))!
    storedOperation = record.handle.operationId
    expect(record.phase).toBe("quarantined")
    expect(record.input!.executionBudget).toEqual(f.budget)
    expect((yield* worker.controlHistory("run-1"))).toHaveLength(2)
    expect((yield* delivery.getRun("run-1"))!.status).toBe("recovering")
  }))
  f.state.afterPrepare = undefined; f.state.denyProof = false
  await withWorker(f.file, f.options, (worker) => Effect.gen(function* () {
    const before = { proofs: f.state.proofCalls, prepares: f.state.prepares }
    expect((yield* worker.resumeStopped("run-1", authorization)).kind).toBe("blocked")
    expect((yield* worker.get("run-1"))!.handle.operationId).toBe(storedOperation)
    expect(f.state.proofCalls).toBe(before.proofs)
    expect(f.state.prepares).toBe(before.prepares)
    expect(spawnCount(f.launch.workingDirectory)).toBe(1)
  }))
}, 20_000)

test("a real SQLite control-history insert failure rolls back stop projection, event, command receipt and dispatch together", async () => {
  const f = fixture()
  let originalTask: TaskState | undefined, originalRecord: WorkerDispatch.DispatchRecord | undefined
  await withWorker(f.file, f.options, (worker, delivery) => Effect.gen(function* () {
    const prior = yield* pausing(f, worker, delivery), { db } = yield* Database.Service
    originalTask = yield* delivery.getTask("task-1"); originalRecord = yield* worker.get("run-1")
    const events = yield* delivery.readEvents("task-1", 0)
    const counts = () => db.get(sql`SELECT
      (SELECT count(*) FROM event) AS events,
      (SELECT count(*) FROM loopit_command_receipt) AS receipts,
      (SELECT count(*) FROM loopit_outbox) AS outbox,
      (SELECT count(*) FROM loopit_worker_control_recovery) AS controls`)
    const before = yield* counts()
    // confirmStopped has already published reportRun and updated its dispatch
    // when appendControl reaches this trigger. Outer transaction must undo all.
    yield* db.run(sql`CREATE TRIGGER fail_control_insert BEFORE INSERT ON loopit_worker_control_recovery
      BEGIN SELECT RAISE(ABORT, 'injected control history failure'); END`)
    const failed = yield* worker.confirmStopped("run-1", stopAuth(prior)).pipe(Effect.exit)
    expect(Exit.isFailure(failed)).toBe(true)
    expect(yield* delivery.getTask("task-1")).toEqual(originalTask)
    expect(yield* delivery.replay("task-1")).toEqual(originalTask)
    expect(yield* delivery.readEvents("task-1", 0)).toEqual(events)
    expect(yield* worker.get("run-1")).toEqual(originalRecord)
    expect(yield* worker.controlHistory("run-1")).toHaveLength(0)
    expect(yield* counts()).toEqual(before)
    expect((yield* delivery.getRun("run-1"))!.status).toBe("pausing")
    expect(spawnCount(f.launch.workingDirectory)).toBe(1)
  }))
  // Check the persisted database through a new service and connection, not
  // merely the failing transaction's in-memory view.
  await withWorker(f.file, f.options, (worker, delivery) => Effect.gen(function* () {
    expect(yield* delivery.getTask("task-1")).toEqual(originalTask)
    expect(yield* worker.get("run-1")).toEqual(originalRecord)
    expect(yield* worker.controlHistory("run-1")).toHaveLength(0)
    const { db } = yield* Database.Service
    yield* db.run(sql`DROP TRIGGER fail_control_insert`)
    yield* worker.confirmStopped("run-1", stopAuth((yield* worker.get("run-1"))!))
    expect((yield* delivery.getRun("run-1"))!.status).toBe("paused")
    expect(yield* worker.controlHistory("run-1")).toHaveLength(1)
    expect(yield* delivery.replay("task-1")).toEqual(yield* delivery.getTask("task-1"))
  }))
}, 20_000)
