import { afterEach, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { digestOf } from "@loopit/contracts"
import { OpenCodeCli, type Handle, type StartInput } from "../../runtime/src"
import type { WorkerDispatch } from "../src"
import { cmd, exec, goal } from "./helpers"
import { setup, spawnCount, until, withWorker } from "./worker-fixture"

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const finish of cleanup.splice(0)) await finish() })
const proof = digestOf("synthetic host-verified stop authorization; not production proof")
const authorization = (record: WorkerDispatch.DispatchRecord, nonce = "recovery-1") => ({ nonce, stopProofDigest: proof, previousOperationId: record.handle.operationId })

/** Tests the recovery protocol with synthetic host bindings, using a real,
 * unprivileged deny-all CLI fixture for lifecycle. No privileged/restricted
 * execution or truth of a Supervisor proof is claimed by this adapter. */
function fixtureInput(value: StartInput): StartInput {
  const context = { ...value.context, effectiveConfig: [
    { kind: "instruction" as const, ref: "input://fixture", digest: digestOf(value.prompt) },
    { kind: "permission" as const, ref: "config://deny-all", digest: digestOf({ "*": "deny" }) },
    { kind: "model" as const, ref: "config://model", digest: digestOf(value.spec.model) },
  ] }
  return { ...value, context, spec: { ...value.spec, contextManifest: { ...value.spec.contextManifest, digest: digestOf(context) } } }
}
function recoveryFixture() {
  const f = setup(), handles: Handle[] = []
  const state = { fail: true, prepares: 0, beforePrepare: undefined as undefined | (() => Promise<void>), launch: {
    ...f.launch, wallMinutes: 2, restrictedBinding: { configDigest: digestOf("old-scope"), permissionDigest: digestOf("fixed permissions") },
    executionBudget: { deadlineAt: new Date(Date.now() + 90_000).toISOString(), repairIndex: 0, maxRepairs: 3 as const },
  } }
  const adapter: WorkerDispatch.Options["adapter"] = {
    prepareStart: async (input, operation) => {
      state.prepares++
      if (state.fail) throw new Error("injected preparation failure before any runtime start")
      await state.beforePrepare?.()
      return f.adapter.prepareStart(fixtureInput(input), operation)
    },
    startPrepared: (input, operation, token) => { const handle = f.adapter.startPrepared(fixtureInput(input), operation, token); handles.push(handle); return handle },
    inspect: f.adapter.inspect.bind(f.adapter), cancel: f.adapter.cancel.bind(f.adapter), collect: f.adapter.collect.bind(f.adapter),
  }
  cleanup.push(async () => { for (const handle of handles) await f.adapter.cancel(handle) })
  return { ...f, state, adapter, options: { adapter, launch: () => state.launch } }
}
const create = (delivery: import("../src").Delivery.Interface) => Effect.gen(function* () {
  yield* exec(delivery, cmd.create({ goal: goal({ objective: "fixture exit" }) }))
  yield* exec(delivery, cmd.start(1, "run-1"))
})

test("explicit preparation recovery keeps same Run/budget, archives history, and deduplicates concurrent authorization", async () => {
  const f = recoveryFixture()
  let expectedHandle: Handle | undefined, used: WorkerDispatch.PreparationRecoveryAuthorization | undefined
  await withWorker(f.file, f.options, (worker, delivery) => Effect.gen(function* () {
    yield* create(delivery); yield* worker.drain()
    const prior = (yield* worker.get("run-1"))!
    expect(prior.phase).toBe("quarantined")
    expect(spawnCount(f.launch.workingDirectory)).toBe(0)
    f.state.fail = false
    f.state.launch = { ...f.state.launch, restrictedBinding: { ...f.state.launch.restrictedBinding, configDigest: digestOf("new-scope") } }
    used = authorization(prior)
    const results = yield* Effect.all(Array.from({ length: 4 }, () => worker.recoverPreparation("run-1", used!)), { concurrency: "unbounded" })
    const current = (yield* worker.get("run-1"))!
    expectedHandle = current.handle
    expect(results.every((result) => digestOf(result.record!.handle) === digestOf(current.handle))).toBe(true)
    expect(current.handle).not.toEqual(prior.handle)
    expect(current.runId).toBe(prior.runId)
    expect(current.input!.executionBudget).toEqual(prior.input!.executionBudget)
    expect(current.input!.context.budget.wallMinutesRemaining).toBeLessThanOrEqual(prior.input!.context.budget.wallMinutesRemaining)
    expect(current.input!.context.budget.wallMinutesRemaining).toBeLessThanOrEqual(Math.floor(
      (Date.parse(prior.input!.executionBudget!.deadlineAt) - Date.parse(current.input!.context.createdAt)) / 60_000))
    expect(current.input!.context.manifestId).not.toBe(prior.input!.context.manifestId)
    expect(current.input!.spec.executionId).not.toBe(prior.input!.spec.executionId)
    expect(current.input!.spec.contextManifest.ref).not.toBe(prior.input!.spec.contextManifest.ref)
    expect(current.input!.context.effectiveConfig).not.toEqual(prior.input!.context.effectiveConfig)
    expect(current.preparationRecoveryCount).toBe(1)
    expect(current.preparationRecoveryNonce).toBe(used!.nonce)
    const history = yield* worker.preparationHistory("run-1")
    expect(history).toHaveLength(1)
    expect(history[0].priorRecord).toEqual(prior)
    expect(history[0].priorRecord.input!.spec.contextManifest.ref).toBe(prior.input!.spec.contextManifest.ref)
    expect(history[0].priorRecordDigest).toBe(digestOf(prior))
    expect(history[0].authorization).toEqual(used!)
    const { db } = yield* Database.Service
    expect(Exit.isFailure(yield* db.run(sql`UPDATE loopit_worker_preparation_recovery SET record = '{}'`).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* db.run(sql`DELETE FROM loopit_worker_preparation_recovery`).pipe(Effect.exit))).toBe(true)
    yield* Effect.promise(() => until(() => spawnCount(f.launch.workingDirectory) === 1))
    expect(f.state.prepares).toBe(2)
    expect(Exit.isFailure(yield* worker.recoverPreparation("run-1", { ...used!, stopProofDigest: digestOf("changed") }).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* worker.recoverPreparation("run-1", authorization(current, "after-start")).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* worker.recoverPreparation("run-1", authorization(prior, "stale-operation")).pipe(Effect.exit))).toBe(true)
  }))
  await withWorker(f.file, { ...f.options, adapter: new OpenCodeCli(f.cli) }, (worker) => Effect.gen(function* () {
    const duplicate = yield* worker.recoverPreparation("run-1", used!)
    expect(duplicate.record!.handle).toEqual(expectedHandle!)
    expect(duplicate.kind).toBe("blocked")
    expect(yield* worker.preparationHistory("run-1")).toHaveLength(1)
    expect(spawnCount(f.launch.workingDirectory)).toBe(1)
  }))
})

test("independent SQLite connections with competing recovery nonces reserve exactly one new Attempt", async () => {
  const f = recoveryFixture()
  const prior = await withWorker(f.file, f.options, (worker, delivery) => Effect.gen(function* () {
    yield* create(delivery); yield* worker.drain()
    return (yield* worker.get("run-1"))!
  }))
  f.state.fail = false
  const results = await Promise.all(["nonce-a", "nonce-a", "nonce-b"].map((nonce) => withWorker(f.file, f.options,
    (worker) => worker.recoverPreparation("run-1", authorization(prior, nonce)).pipe(Effect.exit))))
  expect(results.filter(Exit.isSuccess).length).toBeGreaterThanOrEqual(1)
  await withWorker(f.file, f.options, (worker) => Effect.gen(function* () {
    const current = (yield* worker.get("run-1"))!
    const history = yield* worker.preparationHistory("run-1")
    expect(history).toHaveLength(1)
    expect(current.preparationRecoveryCount).toBe(1)
    expect(results.filter(Exit.isSuccess).every((result) => digestOf(result.value.record!.handle) === digestOf(current.handle))).toBe(true)
    yield* Effect.promise(() => until(() => spawnCount(f.launch.workingDirectory) === 1))
    expect(f.state.prepares).toBe(2)
  }))
})

test("budget reset, changed capabilities, and a fourth preparation recovery fail without replacing prior state", async () => {
  const f = recoveryFixture()
  await withWorker(f.file, f.options, (worker, delivery) => Effect.gen(function* () {
    yield* create(delivery); yield* worker.drain()
    const first = (yield* worker.get("run-1"))!, original = f.state.launch
    for (const changed of [
      { ...original, executionBudget: { ...original.executionBudget, deadlineAt: new Date(Date.parse(original.executionBudget.deadlineAt) + 1000).toISOString() } },
      { ...original, executionBudget: { ...original.executionBudget, repairIndex: 1 } },
      { ...original, executionBudget: { ...original.executionBudget, maxRepairs: 2 as 3 } },
      { ...original, restrictedBinding: { ...original.restrictedBinding, permissionDigest: digestOf("widened") } },
    ]) {
      f.state.launch = changed
      expect(Exit.isFailure(yield* worker.recoverPreparation("run-1", authorization(first)).pipe(Effect.exit))).toBe(true)
      expect(yield* worker.get("run-1")).toEqual(first)
      expect(yield* worker.preparationHistory("run-1")).toHaveLength(0)
    }
    f.state.launch = original
    for (let index = 1; index <= 3; index++) {
      const prior = (yield* worker.get("run-1"))!
      const result = yield* worker.recoverPreparation("run-1", authorization(prior, `bounded-${index}`))
      expect(result.record!.phase).toBe("quarantined")
      expect(result.record!.preparationRecoveryCount).toBe(index)
      expect(result.record!.input!.executionBudget).toEqual(first.input!.executionBudget)
    }
    expect(Exit.isFailure(yield* worker.recoverPreparation("run-1", authorization((yield* worker.get("run-1"))!, "fourth")).pipe(Effect.exit))).toBe(true)
    expect(yield* worker.preparationHistory("run-1")).toHaveLength(3)
    expect(spawnCount(f.launch.workingDirectory)).toBe(0)
  }))
})

test("recovery reservation does not overtake concurrent pause and forbids competing nonce or ambient rollback", async () => {
  const f = recoveryFixture()
  await withWorker(f.file, f.options, (worker, delivery) => Effect.gen(function* () {
    yield* create(delivery); yield* worker.drain()
    const prior = (yield* worker.get("run-1"))!, auth = authorization(prior)
    const { db } = yield* Database.Service
    expect(Exit.isFailure(yield* db.transaction(() => worker.recoverPreparation("run-1", auth), { behavior: "immediate" }).pipe(Effect.exit))).toBe(true)
    expect(yield* worker.preparationHistory("run-1")).toHaveLength(0)
    let entered = false, release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    f.state.fail = false; f.state.beforePrepare = () => { entered = true; return waiting }
    yield* Effect.all([
      worker.recoverPreparation("run-1", auth),
      Effect.gen(function* () {
        yield* Effect.promise(() => until(() => entered))
        try {
          const current = (yield* worker.get("run-1"))!
          expect(current.phase).toBe("reserved")
          expect(Exit.isFailure(yield* worker.recoverPreparation("run-1", authorization(current, "competing")).pipe(Effect.exit))).toBe(true)
          yield* exec(delivery, cmd.pause(2, "run-1"))
        } finally { release() }
      }),
    ], { concurrency: "unbounded" })
    expect((yield* worker.get("run-1"))!.phase).toBe("suppressed")
    expect((yield* delivery.getRun("run-1"))!.status).toBe("pausing")
    expect(spawnCount(f.launch.workingDirectory)).toBe(0)
    expect(Exit.isFailure(yield* worker.recoverPreparation("run-1", authorization((yield* worker.get("run-1"))!, "suppressed")).pipe(Effect.exit))).toBe(true)
  }))
})

test("invalid launch quarantine and unknown dispatch failure never enter preparation recovery", async () => {
  for (const mode of ["invalid-launch", "unknown-start"] as const) {
    const f = recoveryFixture()
    if (mode === "invalid-launch") f.state.launch = { ...f.state.launch, wallMinutes: 0 }
    else { f.state.fail = false; f.adapter.startPrepared = () => { throw new Error("unknown dispatch failure") } }
    await withWorker(f.file, f.options, (worker, delivery) => Effect.gen(function* () {
      yield* create(delivery); yield* worker.drain()
      const prior = (yield* worker.get("run-1"))!
      expect(prior.phase).toBe("quarantined")
      expect(Exit.isFailure(yield* worker.recoverPreparation("run-1", authorization(prior)).pipe(Effect.exit))).toBe(true)
      expect(yield* worker.preparationHistory("run-1")).toHaveLength(0)
      expect(yield* worker.get("run-1")).toEqual(prior)
      expect(spawnCount(f.launch.workingDirectory)).toBe(0)
    }))
  }
})
