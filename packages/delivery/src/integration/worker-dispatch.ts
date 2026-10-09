import { randomUUID } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Context, Effect, Exit, Layer, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { digestOf, parse, type ContextManifest, type EventEnvelope, type GoalSpec } from "@loopit/contracts"
import { remainingExecutionMs, type ExecutionBudget, type Handle, type OpenCodeCli, type RestrictedBinding, type StartInput } from "../../../runtime/src"
import * as Delivery from "../service"
import { ensureDeliveryDurability } from "../database"
import { OutboxTable, ReceiptTable } from "../sql"

type Adapter = Pick<OpenCodeCli, "prepareStart" | "startPrepared" | "inspect" | "cancel" | "collect">
type Observation = ReturnType<Adapter["inspect"]>
export interface Launch {
  workingDirectory: string
  runtime: { name: "opencode"; version: string; sourceDigest: string }
  model: { provider: string; model: string }
  wallMinutes: number
  restrictedBinding?: RestrictedBinding
  executionBudget?: ExecutionBudget
}
export interface Binding { eventId: string; runId: string; taskId: string; goalRevision: number; handle: Handle }
export interface DispatchRecord extends Binding {
  eventDigest: string
  owner: string
  createdAt: string
  goalDigest: string
  phase: "reserved" | "started" | "quarantined" | "suppressed"
  input?: StartInput
  reason?: string
  observed?: Observation
  preparationRecoveryCount?: number
  preparationRecoveryNonce?: string
  resumeNonce?: string
  resumeCommandId?: string
  resumeVersion?: number
}
/** Internal trusted-host port. The caller must independently verify Supervisor
 * stop proofs, scope/identity binding and current account quiescence. This
 * interface stores that authorization's digest; it does not verify its truth. */
export interface PreparationRecoveryAuthorization { nonce: string; stopProofDigest: string; previousOperationId: string }
export interface PreparationRecoveryRecord {
  schemaVersion: "preparation-recovery/1"
  runId: string
  recoveryIndex: number
  requestedAt: string
  authorization: PreparationRecoveryAuthorization
  authorizationDigest: string
  priorRecordDigest: string
  priorRecord: DispatchRecord
  nextRecord: DispatchRecord
}
/** Only a trusted controller may submit these references. The host port below
 * must verify their external truth, identity and current admission boundary. */
export interface StopAuthorization { nonce: string; previousOperationId: string; stopProofDigest: string }
export interface ResumeAuthorization extends StopAuthorization { resumeCommandId: string; runtimeReleaseDigest: string }
export interface VerifiedStopped {
  schemaVersion: "verified-worker-stop/1"
  requestDigest: string
  handle: Handle
  stopProofDigest: string
  scopeId: string
  generation: number
  runtimeReleaseDigest?: string
}
export interface VerifyStoppedInput {
  mode: "stop" | "resume"
  record: DispatchRecord
  authorization: StopAuthorization | ResumeAuthorization
  controlEvent: EventEnvelope
}
export interface ControlRecoveryRecord {
  schemaVersion: "worker-control-recovery/1"
  kind: "stop" | "resume"
  runId: string
  requestedAt: string
  authorization: StopAuthorization | ResumeAuthorization
  controlEvent: EventEnvelope
  verified: VerifiedStopped
  priorRecord: DispatchRecord
  nextRecord: DispatchRecord
  targetStatus: "paused" | "cancelled" | "recovering"
}
export interface Result {
  kind: "ignored" | "observed" | "blocked"
  gate: "not_evaluated"
  record?: DispatchRecord
  reason?: string
}
export interface Options {
  adapter: Adapter
  /** Pure, synchronous trusted host configuration; not a model/tool argument.
   * Called only by a winning initial/explicit preparation-recovery reservation. */
  launch: (goal: GoalSpec, binding: Binding) => Launch
  /** No default. Verify dual identity stop proofs, exact Attempt/control event,
   * live scope/generation, and current launch admission under host ownership.
   * Resume also verifies the archived Runtime reservation release receipt. */
  verifyStopped?: (input: VerifyStoppedInput) => Promise<VerifiedStopped>
}
export interface Interface {
  consume(item: Delivery.OutboxItem): Effect.Effect<Result, Error>
  drain(limit?: number): Effect.Effect<number>
  inspect(runId: string): Effect.Effect<Result, Error>
  get(runId: string): Effect.Effect<DispatchRecord | undefined>
  recoverPreparation(runId: string, authorization: PreparationRecoveryAuthorization): Effect.Effect<Result, Error>
  preparationHistory(runId: string): Effect.Effect<PreparationRecoveryRecord[]>
  confirmStopped(runId: string, authorization: StopAuthorization): Effect.Effect<Result, Error>
  resumeStopped(runId: string, authorization: ResumeAuthorization): Effect.Effect<Result, Error>
  controlHistory(runId: string): Effect.Effect<ControlRecoveryRecord[]>
}
export class Service extends Context.Service<Service, Interface>()("@loopit/delivery/WorkerDispatch") {}
const DispatchTable = sqliteTable("loopit_worker_dispatch", {
  run_id: text().primaryKey(), event_id: text().notNull().unique(), attempt_id: text().notNull().unique(),
  operation_id: text().notNull().unique(), record: text({ mode: "json" }).notNull(),
})
const RecoveryTable = sqliteTable("loopit_worker_preparation_recovery", {
  nonce: text().primaryKey(), run_id: text().notNull(), recovery_index: integer().notNull(),
  request_digest: text().notNull(), record: text({ mode: "json" }).notNull(),
})
const ControlRecoveryTable = sqliteTable("loopit_worker_control_recovery", {
  nonce: text().primaryKey(), run_id: text().notNull(), operation_id: text().notNull(),
  kind: text().notNull(), event_id: text().notNull(), request_digest: text().notNull(), record: text({ mode: "json" }).notNull(),
})
const migrations: DatabaseMigration.Migration[] = [{
  id: "loopit_worker_dispatch_0001",
  up: (tx) => tx.run(sql`CREATE TABLE loopit_worker_dispatch (
    run_id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL UNIQUE,
    attempt_id TEXT NOT NULL UNIQUE, operation_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL)`).pipe(Effect.asVoid),
}, {
  id: "loopit_worker_dispatch_0002_preparation_recovery",
  up: (tx) => Effect.gen(function* () {
    yield* tx.run(sql`CREATE TABLE IF NOT EXISTS loopit_worker_preparation_recovery (
      nonce TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL, recovery_index INTEGER NOT NULL,
      request_digest TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(run_id, recovery_index))`)
    yield* tx.run(sql`CREATE TRIGGER IF NOT EXISTS loopit_worker_preparation_recovery_no_update
      BEFORE UPDATE ON loopit_worker_preparation_recovery BEGIN SELECT RAISE(ABORT, 'preparation recovery history is immutable'); END`)
    yield* tx.run(sql`CREATE TRIGGER IF NOT EXISTS loopit_worker_preparation_recovery_no_delete
      BEFORE DELETE ON loopit_worker_preparation_recovery BEGIN SELECT RAISE(ABORT, 'preparation recovery history is immutable'); END`)
  }),
}, {
  id: "loopit_worker_dispatch_0003_control_recovery",
  up: (tx) => Effect.gen(function* () {
    yield* tx.run(sql`CREATE TABLE IF NOT EXISTS loopit_worker_control_recovery (
      nonce TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL, operation_id TEXT NOT NULL,
      kind TEXT NOT NULL, event_id TEXT NOT NULL, request_digest TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(kind,event_id))`)
    yield* tx.run(sql`CREATE TRIGGER IF NOT EXISTS loopit_worker_control_recovery_no_update
      BEFORE UPDATE ON loopit_worker_control_recovery BEGIN SELECT RAISE(ABORT, 'control recovery history is immutable'); END`)
    yield* tx.run(sql`CREATE TRIGGER IF NOT EXISTS loopit_worker_control_recovery_no_delete
      BEFORE DELETE ON loopit_worker_control_recovery BEGIN SELECT RAISE(ABORT, 'control recovery history is immutable'); END`)
  }),
}]
const preparationFailed = "runtime preparation failed; no new process dispatched"
const key = (prefix: string, value: unknown) => `${prefix}-${digestOf(value).slice(7, 55)}`
const errorOf = (error: unknown) => error instanceof Error ? error : new Error(String(error))
const blocked = (record: DispatchRecord | undefined, reason: string): Result => ({ kind: "blocked", gate: "not_evaluated", record, reason })
function validateControlAuthorization(input: StopAuthorization | ResumeAuthorization, resume: boolean) {
  const expected = resume ? "nonce,previousOperationId,resumeCommandId,runtimeReleaseDigest,stopProofDigest" : "nonce,previousOperationId,stopProofDigest"
  if (!input || Object.keys(input).sort().join(",") !== expected) throw new Error("Invalid trusted control authorization")
  for (const field of ["nonce", "previousOperationId", ...(resume ? ["resumeCommandId"] : [])])
    if (typeof (input as any)[field] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test((input as any)[field])) throw new Error("Invalid control identity")
  for (const field of ["stopProofDigest", ...(resume ? ["runtimeReleaseDigest"] : [])])
    if (!/^sha256:[0-9a-f]{64}$/.test((input as any)[field])) throw new Error("Invalid control proof digest")
  return Object.freeze({ ...input })
}
const stableLaunch = (value: StartInput) => ({ prompt: value.prompt, runtime: value.spec.runtime, model: value.spec.model,
  workingDirectory: value.spec.workingDirectory, policyRef: value.spec.policyRef, budget: value.spec.budget,
  outputContract: value.spec.outputContract, repairCyclesRemaining: value.context.budget.repairCyclesRemaining,
  permission: value.context.effectiveConfig.filter((entry) => entry.kind === "permission") })

/** Materializes only the input subset actually supported by the local adapter. */
export function buildStartInput(goal: GoalSpec, binding: Binding, launch: Launch, createdAt: string): StartInput {
  if (!Number.isSafeInteger(launch.wallMinutes) || launch.wallMinutes < 1 || launch.wallMinutes > goal.budgets.wallMinutes)
    throw new Error("Launch wall budget must be within the frozen goal budget")
  const [policyRef, policyDigest] = goal.policyRef.split("#")
  if (!policyDigest || !/^sha256:[0-9a-f]{64}$/.test(policyDigest)) throw new Error("Frozen policy pin is required")
  if (launch.restrictedBinding) {
    if (!launch.executionBudget) throw new Error("Restricted launch requires a frozen absolute execution budget")
    remainingExecutionMs(launch.executionBudget)
    if (Date.parse(launch.executionBudget.deadlineAt) > Date.parse(createdAt) + Math.min(60, goal.budgets.wallMinutes) * 60_000 ||
        launch.executionBudget.repairIndex > Math.min(3, goal.budgets.maxRepairCycles)) throw new Error("Execution budget exceeds frozen goal limits")
  } else if (launch.executionBudget) throw new Error("Execution budget requires a bound restricted launch")
  const prompt = JSON.stringify({ goal }, null, 2)
  const context: ContextManifest = {
    schemaVersion: "context/1", manifestId: key("context", [binding.eventId, binding.handle.attemptId]), attemptId: binding.handle.attemptId, createdAt,
    goal: { taskId: goal.taskId, goalRevision: goal.goalRevision, digest: digestOf(goal) },
    policy: { ref: policyRef, digest: policyDigest }, toolCapabilities: [],
    effectiveConfig: [
      { kind: "instruction", ref: "input://frozen-goal", digest: digestOf(prompt) },
      { kind: "permission", ref: launch.restrictedBinding ? "config://restricted-permissions" : "config://deny-all", digest: launch.restrictedBinding?.permissionDigest ?? digestOf({ "*": "deny" }) },
      { kind: "model", ref: "config://model", digest: digestOf(launch.model) },
      ...(launch.restrictedBinding ? [
        { kind: "model" as const, ref: "config://opencode-restricted", digest: launch.restrictedBinding.configDigest },
        { kind: "instruction" as const, ref: "config://execution-budget", digest: digestOf(launch.executionBudget) },
      ] : []),
    ],
    knowledgeRefs: [], historyRefs: [], budget: {
      // Context's existing contract uses whole minutes: round down, never
      // present a fresh full allowance after a preparation recovery.
      wallMinutesRemaining: launch.executionBudget ? Math.max(0, Math.min(launch.wallMinutes,
        Math.floor((Date.parse(launch.executionBudget.deadlineAt) - Date.parse(createdAt)) / 60_000))) : launch.wallMinutes,
      repairCyclesRemaining: launch.executionBudget ? Math.min(3, goal.budgets.maxRepairCycles) - launch.executionBudget.repairIndex : 0,
    },
  }
  const input: StartInput = { prompt, context, ...(launch.executionBudget ? { executionBudget: launch.executionBudget } : {}), spec: {
    schemaVersion: "execution/1", executionId: key("execution", [binding.eventId, binding.handle.operationId]), attemptId: binding.handle.attemptId,
    runtime: launch.runtime, model: launch.model, workingDirectory: launch.workingDirectory,
    contextManifest: { ref: `artifact://${context.manifestId}`, digest: digestOf(context) }, policyRef: goal.policyRef,
    budget: { wallMinutes: launch.wallMinutes, maxRetries: 0 }, outputContract: { artifactKinds: goal.delivery.artifactKinds ?? [] },
  } }
  if (!parse("execution", input.spec).ok || !parse("context", context).ok) throw new Error("Invalid execution/context contract")
  return input
}

/** Outbox wiring, not a Supervisor or Agent loop. Only explicit, bounded,
 * host-authorized preparation failure recovery can replace a Run's Attempt. */
export const layerWith = (options: Options) => Layer.effect(Service, Effect.gen(function* () {
  const { db } = yield* Database.Service
  const delivery = yield* Delivery.Service
  yield* ensureDeliveryDurability(db).pipe(Effect.orDie)
  yield* db.transaction((tx) => DatabaseMigration.applyOnly(tx, migrations), { behavior: "immediate" }).pipe(Effect.orDie)
  const owner = randomUUID()
  const requireTopLevel = Effect.gen(function* () {
    const ambient = yield* Effect.serviceOption(db.$client.transactionService)
    if (Option.isSome(ambient)) return yield* Effect.fail(new Error("Worker dispatch requires a top-level committed boundary; ambient transactions are forbidden"))
  })
  const get = (runId: string) => db.select().from(DispatchTable).where(eq(DispatchTable.run_id, runId)).get().pipe(
    Effect.orDie, Effect.map((row) => row?.record as DispatchRecord | undefined))
  const save = (record: DispatchRecord) => db.update(DispatchTable).set({ record }).where(and(
    eq(DispatchTable.run_id, record.runId), eq(DispatchTable.operation_id, record.handle.operationId))).run().pipe(Effect.orDie)
  const preparationHistory = (runId: string) => db.select().from(RecoveryTable).where(eq(RecoveryTable.run_id, runId))
    .orderBy(RecoveryTable.recovery_index).all().pipe(Effect.orDie, Effect.map((rows) => rows.map((row) => row.record as PreparationRecoveryRecord)))
  const controlHistory = (runId: string) => db.select().from(ControlRecoveryTable).where(eq(ControlRecoveryTable.run_id, runId)).all()
    .pipe(Effect.orDie, Effect.map((rows) => rows.map((row) => row.record as ControlRecoveryRecord)))
  const transaction = <A>(effect: Effect.Effect<A, Error>) => db.transaction(() => effect, { behavior: "immediate" }).pipe(Effect.mapError(errorOf))
  const snapshot = (record: DispatchRecord) => Effect.try({ try: () => options.adapter.inspect(record.handle), catch: errorOf })
  const report = (record: DispatchRecord, to: "running" | "waiting" | "failed", reason: string) => delivery.execute({
    schemaVersion: "command/1", type: "reportRun", commandId: key("runtime-fact", [record.eventId, record.handle.operationId, to]),
    taskId: record.taskId, runId: record.runId, issuedAt: record.createdAt,
    actor: { kind: "worker", id: "local-runtime" }, to, reason,
    ...(to === "failed" ? { closeRevision: false } : {}),
  }).pipe(Effect.asVoid)
  const observe = (record: DispatchRecord): Effect.Effect<Result, Error> => Effect.gen(function* () {
    const observed = yield* snapshot(record).pipe(Effect.exit)
    if (Exit.isFailure(observed)) return blocked(record, "runtime_receipt_missing_or_unreadable; reconciliation required")
    const value = observed.value
    if (value.ownership !== "local") return blocked({ ...record, observed: value }, "previous_execution_ownership_unknown; redispatch forbidden")
    const next = yield* transaction(Effect.gen(function* () {
      const current = (yield* get(record.runId)) ?? record
      if (current.handle.operationId !== record.handle.operationId) return undefined
      const next = { ...current, observed: value }
      yield* save(next)
      return next
    }))
    if (!next) return blocked(record, "Attempt superseded; stale observation cannot update current dispatch")
    if (!value.evidence.available) return blocked(next, "runtime_evidence_unavailable")
    let run = yield* delivery.getRun(record.runId)
    if ((run?.status === "queued" || (run?.status === "recovering" && record.resumeCommandId)) && value.events.some((event) => event.type === "started")) {
      yield* report(record, "running", "Runtime reported a locally owned process start")
      run = yield* delivery.getRun(record.runId)
    }
    if (run?.status === "running" && value.status === "exited")
      yield* report(record, "waiting", "Local process exited; delivery verification and resource reconciliation remain unverified")
    if (run?.status === "queued" && value.status === "spawn_failed")
      yield* report(record, "failed", "Locally owned Runtime observed process spawn failure")
    return { kind: "observed", gate: "not_evaluated", record: next }
  })
  const stop = (record: DispatchRecord, reason: "cancel" | "pause") => Effect.gen(function* () {
    // Stop first: a failed SQLite write must not block emergency signalling of an
    // adapter-owned child. Recovered/unknown handles are never blindly signalled.
    const result = yield* Effect.tryPromise({ try: () => options.adapter.cancel(record.handle, reason), catch: errorOf }).pipe(Effect.exit)
    if (Exit.isFailure(result)) return blocked(record, "stop_receipt_unavailable; reconciliation required")
    const observed = result.value.observed
    const next = yield* transaction(Effect.gen(function* () {
      const current = (yield* get(record.runId)) ?? record
      if (current.handle.operationId !== record.handle.operationId) return undefined
      const next = { ...current, observed, reason: "stop requested; independent descendant/resource reconciliation still required" }
      yield* save(next)
      return next
    }))
    if (!next) return blocked(record, "Attempt superseded; old stop observation cannot update current dispatch")
    // The current adapter always returns safeToRedispatch=false. Never convert
    // leader exit/group absence into paused/cancelled or release its reservation.
    return blocked(next, next.reason)
  })
  const dispatchReserved = (record: DispatchRecord, beforeDispatch?: () => Effect.Effect<void, Error>): Effect.Effect<Result, Error> => Effect.gen(function* () {
    if (!record.input) return blocked(record, record.reason ?? "invalid launch")
    // Version/help probes are bounded asynchronous subprocesses, outside the
    // write transaction. A concurrent pause/cancel remains able to commit.
    const prepared = yield* Effect.tryPromise({
      try: () => options.adapter.prepareStart(record.input!, record.handle.operationId), catch: errorOf,
    }).pipe(Effect.exit)
    if (Exit.isFailure(prepared)) {
      const quarantined: DispatchRecord = { ...record, phase: "quarantined", reason: preparationFailed }
      yield* save(quarantined)
      return blocked(quarantined, quarantined.reason!)
    }
    if (beforeDispatch) {
      const authorized = yield* beforeDispatch().pipe(Effect.exit)
      if (Exit.isFailure(authorized)) {
        const quarantined: DispatchRecord = { ...record, phase: "quarantined", reason: "resume stop authorization no longer valid; no new process dispatched" }
        yield* save(quarantined)
        return blocked(quarantined, quarantined.reason!)
      }
    }
    // Reservation is committed before the adapter is called. The second short
    // transaction orders the final queued-state check/start against controls:
    // a committed pause/cancel cannot be overtaken by this synchronous start.
    const dispatched = yield* transaction(Effect.gen(function* () {
      const current = yield* get(record.runId)
      if (current?.handle.operationId !== record.handle.operationId || current.phase !== "reserved" || current.owner !== owner)
        return yield* Effect.fail(new Error("Dispatch reservation ownership changed; start forbidden"))
      const run = yield* delivery.getRun(record.runId)
      const task = record.resumeCommandId ? yield* delivery.getTask(record.taskId) : undefined
      if (run?.status !== (record.resumeCommandId ? "recovering" : "queued") || (record.resumeCommandId && task?.version !== record.resumeVersion)) {
        const suppressed: DispatchRecord = { ...record, phase: "suppressed", reason: "Run control intent changed; no new process dispatched" }
        yield* save(suppressed)
        return suppressed
      }
      const handle = yield* Effect.try({ try: () => options.adapter.startPrepared(record.input!, record.handle.operationId, prepared.value), catch: errorOf })
      if (digestOf(handle) !== digestOf(record.handle)) return yield* Effect.fail(new Error("Runtime returned a different dispatch identity"))
      const started: DispatchRecord = { ...record, phase: "started" }
      yield* save(started)
      return started
    })).pipe(Effect.exit)
    if (Exit.isFailure(dispatched)) {
      // A start exception or lost post-spawn commit is ambiguous. Do not retry.
      // An owned child is stopped even if persisting the failure also fails.
      yield* Effect.tryPromise({ try: () => options.adapter.cancel(record.handle), catch: errorOf }).pipe(Effect.exit)
      const quarantined: DispatchRecord = { ...record, phase: "quarantined", reason: "dispatch failed or receipt lost; reconciliation required" }
      yield* save(quarantined)
      return blocked(quarantined, quarantined.reason!)
    }
    if (dispatched.value.phase === "suppressed") return blocked(dispatched.value, dispatched.value.reason!)
    return yield* observe(dispatched.value)
  })
  const recoverPreparation = (runId: string, authorization: PreparationRecoveryAuthorization): Effect.Effect<Result, Error> => Effect.gen(function* () {
    yield* requireTopLevel
    yield* Effect.try({ try: () => {
      const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
      if (!authorization || Object.keys(authorization).sort().join(",") !== "nonce,previousOperationId,stopProofDigest" ||
          typeof authorization.nonce !== "string" || typeof authorization.previousOperationId !== "string" || typeof authorization.stopProofDigest !== "string" ||
          !id.test(authorization.nonce) || !id.test(authorization.previousOperationId) ||
          !/^sha256:[0-9a-f]{64}$/.test(authorization.stopProofDigest)) throw new Error("Invalid trusted preparation recovery authorization")
      authorization = Object.freeze({ ...authorization })
    }, catch: errorOf })
    const requestDigest = digestOf({ runId, authorization })
    const reservation = yield* transaction(Effect.gen(function* () {
      const used = yield* db.select().from(RecoveryTable).where(eq(RecoveryTable.nonce, authorization.nonce)).get().pipe(Effect.orDie)
      if (used) {
        if (used.request_digest !== requestDigest) return yield* Effect.fail(new Error("Preparation recovery nonce reused with different authorization"))
        return { record: (used.record as PreparationRecoveryRecord).nextRecord, fresh: false }
      }
      const prior = yield* get(runId)
      if (!prior || prior.handle.operationId !== authorization.previousOperationId)
        return yield* Effect.fail(new Error("Preparation recovery does not match the previous operation"))
      if (prior.phase !== "quarantined" || prior.reason !== preparationFailed || prior.observed || !prior.input || prior.input.spec.nativeSessionRef)
        return yield* Effect.fail(new Error("Only known preparation failure without execution/native ownership may recover"))
      const run = yield* delivery.getRun(runId)
      const task = run ? yield* delivery.getTask(run.taskId) : undefined
      const revision = task?.revisions[prior.goalRevision]
      if (!run || run.status !== "queued" || run.taskId !== prior.taskId || run.goalRevision !== prior.goalRevision ||
          task?.currentRevision !== prior.goalRevision || !revision?.frozen || revision.goalDigest !== prior.goalDigest ||
          digestOf(revision.goal) !== prior.goalDigest || prior.input.context.goal.digest !== prior.goalDigest ||
          prior.input.context.goal.taskId !== prior.taskId || prior.input.context.goal.goalRevision !== prior.goalRevision ||
          prior.input.spec.attemptId !== prior.handle.attemptId || prior.input.context.attemptId !== prior.handle.attemptId ||
          prior.input.spec.contextManifest.digest !== digestOf(prior.input.context) || !parse("execution", prior.input.spec).ok || !parse("context", prior.input.context).ok)
        return yield* Effect.fail(new Error("Preparation recovery requires the same queued Run and current frozen goal"))
      const history = yield* preparationHistory(runId)
      if (history.length !== (prior.preparationRecoveryCount ?? 0) || history.length >= 3)
        return yield* Effect.fail(new Error("Preparation recovery history/count mismatch or three-recovery limit reached"))
      const budget = prior.input.executionBudget
      if (!budget) return yield* Effect.fail(new Error("Preparation recovery requires the original frozen absolute execution budget"))
      const at = new Date().toISOString()
      const binding: Binding = { eventId: prior.eventId, runId, taskId: prior.taskId, goalRevision: prior.goalRevision,
        handle: { attemptId: key("attempt-recovery", [runId, authorization.nonce]), operationId: key("runtime-recovery", [runId, authorization.nonce]) } }
      const input = yield* Effect.try({ try: () => {
        remainingExecutionMs(budget)
        const launch = options.launch(revision.goal, binding)
        if (!launch.restrictedBinding || !launch.executionBudget || digestOf(launch.executionBudget) !== digestOf(budget))
          throw new Error("Preparation recovery cannot reset deadline, repairIndex or maxRepairs")
        const input = buildStartInput(revision.goal, binding, launch, at)
        if (input.context.budget.wallMinutesRemaining > prior.input!.context.budget.wallMinutesRemaining)
          throw new Error("Preparation recovery cannot increase remaining wall budget")
        const stable = (value: StartInput) => ({ prompt: value.prompt, runtime: value.spec.runtime, model: value.spec.model,
          workingDirectory: value.spec.workingDirectory, policyRef: value.spec.policyRef, budget: value.spec.budget,
          outputContract: value.spec.outputContract, repairCyclesRemaining: value.context.budget.repairCyclesRemaining,
          permission: value.context.effectiveConfig.filter((entry) => entry.kind === "permission") })
        if (digestOf(stable(input)) !== digestOf(stable(prior.input!))) throw new Error("Preparation recovery cannot change frozen launch capabilities")
        return input
      }, catch: errorOf })
      const next: DispatchRecord = { ...binding, eventDigest: prior.eventDigest, owner, createdAt: at, goalDigest: prior.goalDigest,
        phase: "reserved", input, preparationRecoveryCount: history.length + 1, preparationRecoveryNonce: authorization.nonce }
      const recovery: PreparationRecoveryRecord = { schemaVersion: "preparation-recovery/1", runId, recoveryIndex: history.length + 1,
        requestedAt: at, authorization: { ...authorization }, authorizationDigest: digestOf(authorization),
        priorRecordDigest: digestOf(prior), priorRecord: prior, nextRecord: next }
      yield* db.insert(RecoveryTable).values({ nonce: authorization.nonce, run_id: runId, recovery_index: recovery.recoveryIndex,
        request_digest: requestDigest, record: recovery }).run().pipe(Effect.orDie)
      yield* db.update(DispatchTable).set({ attempt_id: next.handle.attemptId, operation_id: next.handle.operationId, record: next })
        .where(eq(DispatchTable.run_id, runId)).run().pipe(Effect.orDie)
      return { record: next, fresh: true }
    }))
    if (!reservation.fresh) return blocked(reservation.record, "Preparation recovery authorization already consumed; no redispatch")
    return yield* dispatchReserved(reservation.record)
  })
  const controlDuplicate = (runId: string, kind: "stop" | "resume", authorization: StopAuthorization | ResumeAuthorization) => Effect.gen(function* () {
    const row = yield* db.select().from(ControlRecoveryTable).where(eq(ControlRecoveryTable.nonce, authorization.nonce)).get().pipe(Effect.orDie)
    if (!row) return undefined
    if (row.request_digest !== digestOf({ runId, kind, authorization })) return yield* Effect.fail(new Error("Control authorization nonce reused with different request"))
    return (row.record as ControlRecoveryRecord).nextRecord
  })
  const knownStopped = (record: DispatchRecord) => Effect.gen(function* () {
    const observed = yield* snapshot(record)
    // A cold adapter has unknown live ownership. Its complete persisted exit
    // is necessary, but not sufficient: the independent host proof is mandatory.
    if (digestOf(observed.handle) !== digestOf(record.handle) || !observed.evidence.available ||
        !["exited", "spawn_failed"].includes(observed.status) || observed.processGroup === "alive")
      return yield* Effect.fail(new Error("Runtime has no complete stopped execution observation"))
    return observed
  })
  const verifiedStop = (request: VerifyStoppedInput) => Effect.gen(function* () {
    if (!options.verifyStopped) return yield* Effect.fail(new Error("Independent stop verifier is unavailable"))
    yield* knownStopped(request.record)
    const proof = yield* Effect.tryPromise({ try: () => options.verifyStopped!(request), catch: errorOf })
    if (!proof || proof.schemaVersion !== "verified-worker-stop/1" || proof.requestDigest !== digestOf(request) ||
        digestOf(proof.handle) !== digestOf(request.record.handle) || proof.stopProofDigest !== request.authorization.stopProofDigest ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(proof.scopeId) || !Number.isSafeInteger(proof.generation) || proof.generation < 1 ||
        (request.mode === "resume" && proof.runtimeReleaseDigest !== (request.authorization as ResumeAuthorization).runtimeReleaseDigest))
      return yield* Effect.fail(new Error("Independent stop proof binding is invalid"))
    return proof
  })
  const currentControl = (record: DispatchRecord, resumeCommandId?: string) => Effect.gen(function* () {
    const task = yield* delivery.getTask(record.taskId), run = task?.runs[record.runId]
    if (!task || !run) return yield* Effect.fail(new Error("Control Run missing"))
    let event: EventEnvelope | undefined
    if (resumeCommandId) {
      const row = yield* db.select().from(ReceiptTable).where(eq(ReceiptTable.command_id, resumeCommandId)).get().pipe(Effect.orDie)
      const receipt = row?.receipt as import("@loopit/contracts").CommandReceipt | undefined
      if (row?.task_id !== record.taskId || receipt?.status !== "accepted" || receipt.commandType !== "resumeRun" || !receipt.eventId)
        return yield* Effect.fail(new Error("A committed resumeRun receipt is required"))
      const outbox = yield* db.select().from(OutboxTable).where(eq(OutboxTable.event_id, receipt.eventId)).get().pipe(Effect.orDie)
      event = outbox?.envelope as EventEnvelope | undefined
    } else {
      const row = yield* db.select().from(OutboxTable).where(and(eq(OutboxTable.task_id, record.taskId),
        sql`json_extract(${OutboxTable.envelope}, '$.aggregateVersion') = ${task.version}`)).get().pipe(Effect.orDie)
      event = row?.envelope as EventEnvelope | undefined
    }
    const payload = event?.payload as { runId?: string; from?: string; to?: string; cause?: string } | undefined
    const expected = resumeCommandId ? "recovering" : run.status
    if (!event || event.aggregateId !== task.taskId || event.aggregateVersion !== task.version || event.eventType !== "loopit.run.transitioned" ||
        payload?.runId !== run.runId || payload.to !== expected || run.status !== expected ||
        (resumeCommandId ? payload.cause !== "resumeRun" || payload.from !== "paused" || event.commandId !== resumeCommandId
          : !["pausing", "cancelling"].includes(run.status) || payload.cause !== (run.status === "pausing" ? "pauseRun" : "cancelRun")))
      return yield* Effect.fail(new Error("Current committed control event does not authorize this operation"))
    return { task, run, event }
  })
  const appendControl = (value: ControlRecoveryRecord) => db.insert(ControlRecoveryTable).values({
    nonce: value.authorization.nonce, run_id: value.runId, operation_id: value.priorRecord.handle.operationId,
    kind: value.kind, event_id: value.controlEvent.eventId,
    request_digest: digestOf({ runId: value.runId, kind: value.kind, authorization: value.authorization }), record: value,
  }).run().pipe(Effect.orDie)
  const confirmStopped = (runId: string, raw: StopAuthorization): Effect.Effect<Result, Error> => Effect.gen(function* () {
    yield* requireTopLevel
    const authorization = yield* Effect.try({ try: () => validateControlAuthorization(raw, false) as StopAuthorization, catch: errorOf })
    const duplicate = yield* controlDuplicate(runId, "stop", authorization)
    if (duplicate) return blocked(duplicate, "Stop authorization already consumed; no state transition repeated")
    const prior = yield* get(runId)
    if (!prior?.input || prior.phase !== "started" || prior.handle.operationId !== authorization.previousOperationId)
      return yield* Effect.fail(new Error("Stop authorization does not match the current started Attempt"))
    const control = yield* currentControl(prior)
    const verified = yield* verifiedStop({ mode: "stop", record: prior, authorization, controlEvent: control.event })
    return yield* transaction(Effect.gen(function* () {
      const duplicate = yield* controlDuplicate(runId, "stop", authorization)
      if (duplicate) return blocked(duplicate, "Stop authorization already consumed; no state transition repeated")
      const current = yield* get(runId), fresh = yield* currentControl(prior)
      if (!current || digestOf(current) !== digestOf(prior) || fresh.event.eventId !== control.event.eventId)
        return yield* Effect.fail(new Error("Attempt or control intent changed during stop verification"))
      const observed = yield* knownStopped(prior), next = { ...prior, observed }
      const to = control.run.status === "pausing" ? "paused" as const : "cancelled" as const
      const receipt = yield* delivery.execute({ schemaVersion: "command/1", type: "reportRun", commandId: key("verified-stop", authorization.nonce),
        taskId: prior.taskId, runId, expectedVersion: fresh.task.version, issuedAt: new Date().toISOString(),
        actor: { kind: "system", id: "independent-stop-verifier" }, to, reason: "Independent host verified exact Attempt stop and resource boundary" })
      if (receipt.kind !== "receipt" || receipt.receipt.status !== "accepted") return yield* Effect.fail(new Error("Verified stop report rejected"))
      yield* save(next)
      yield* appendControl({ schemaVersion: "worker-control-recovery/1", kind: "stop", runId, requestedAt: new Date().toISOString(),
        authorization, controlEvent: control.event, verified, priorRecord: prior, nextRecord: next, targetStatus: to })
      return { kind: "observed", gate: "not_evaluated", record: next } as Result
    }))
  })
  const resumeStopped = (runId: string, raw: ResumeAuthorization): Effect.Effect<Result, Error> => Effect.gen(function* () {
    yield* requireTopLevel
    const authorization = yield* Effect.try({ try: () => validateControlAuthorization(raw, true) as ResumeAuthorization, catch: errorOf })
    const duplicate = yield* controlDuplicate(runId, "resume", authorization)
    if (duplicate) return blocked(duplicate, "Resume authorization already consumed; no redispatch")
    const prior = yield* get(runId)
    if (!prior?.input?.executionBudget || prior.phase !== "started" || prior.handle.operationId !== authorization.previousOperationId)
      return yield* Effect.fail(new Error("Resume requires a stopped started Attempt with its original absolute budget"))
    const control = yield* currentControl(prior, authorization.resumeCommandId)
    const stop = (yield* controlHistory(runId)).find((entry) => entry.kind === "stop" && entry.targetStatus === "paused" &&
      entry.priorRecord.handle.operationId === prior.handle.operationId && entry.authorization.stopProofDigest === authorization.stopProofDigest)
    if (!stop) return yield* Effect.fail(new Error("Resume requires this Attempt's persisted verified pause"))
    const request: VerifyStoppedInput = { mode: "resume", record: prior, authorization, controlEvent: control.event }
    const verified = yield* verifiedStop(request)
    const reservation = yield* transaction(Effect.gen(function* () {
      const duplicate = yield* controlDuplicate(runId, "resume", authorization)
      if (duplicate) return { record: duplicate, fresh: false }
      const current = yield* get(runId), fresh = yield* currentControl(prior, authorization.resumeCommandId)
      if (!current || digestOf(current) !== digestOf(prior) || fresh.event.eventId !== control.event.eventId)
        return yield* Effect.fail(new Error("Attempt or control intent changed during resume verification"))
      const revision = fresh.task.revisions[prior.goalRevision]
      if (fresh.task.currentRevision !== prior.goalRevision || !revision.frozen || revision.goalDigest !== prior.goalDigest ||
          fresh.run.goalRevision !== prior.goalRevision || prior.input!.spec.nativeSessionRef)
        return yield* Effect.fail(new Error("Resume cannot change the frozen GoalRevision or adopt a native session"))
      const at = new Date().toISOString(), binding: Binding = { eventId: prior.eventId, taskId: prior.taskId, runId, goalRevision: prior.goalRevision,
        handle: { attemptId: key("attempt", [runId, control.event.eventId, authorization.nonce]), operationId: key("runtime-resume", [control.event.eventId, authorization.nonce]) } }
      const input = yield* Effect.try({ try: () => {
        remainingExecutionMs(prior.input!.executionBudget!)
        const launch = options.launch(revision.goal, binding)
        if (!launch.restrictedBinding || digestOf(launch.executionBudget) !== digestOf(prior.input!.executionBudget)) throw new Error("Resume cannot reset the execution budget")
        const input = buildStartInput(revision.goal, binding, launch, at)
        if (digestOf(stableLaunch(input)) !== digestOf(stableLaunch(prior.input!)) ||
            input.context.budget.wallMinutesRemaining > prior.input!.context.budget.wallMinutesRemaining)
          throw new Error("Resume cannot change frozen launch capabilities or increase remaining budget")
        return input
      }, catch: errorOf })
      const next: DispatchRecord = { ...binding, eventDigest: prior.eventDigest, owner, createdAt: at, goalDigest: prior.goalDigest, phase: "reserved", input,
        preparationRecoveryCount: prior.preparationRecoveryCount, resumeNonce: authorization.nonce, resumeCommandId: authorization.resumeCommandId, resumeVersion: fresh.task.version }
      yield* appendControl({ schemaVersion: "worker-control-recovery/1", kind: "resume", runId, requestedAt: at, authorization,
        controlEvent: control.event, verified, priorRecord: prior, nextRecord: next, targetStatus: "recovering" })
      yield* db.update(DispatchTable).set({ attempt_id: next.handle.attemptId, operation_id: next.handle.operationId, record: next })
        .where(eq(DispatchTable.run_id, runId)).run().pipe(Effect.orDie)
      return { record: next, fresh: true }
    }))
    if (!reservation.fresh) return blocked(reservation.record, "Resume authorization already consumed; no redispatch")
    return yield* dispatchReserved(reservation.record, () => verifiedStop(request).pipe(Effect.asVoid))
  })
  const consume = (item: Delivery.OutboxItem): Effect.Effect<Result, Error> => Effect.gen(function* () {
    yield* requireTopLevel
    const row = yield* db.select().from(OutboxTable).where(eq(OutboxTable.id, item.id)).get().pipe(Effect.orDie)
    if (!row || digestOf(row.envelope) !== digestOf(item.envelope)) return yield* Effect.fail(new Error("Event is not this database's committed outbox item"))
    const event = row.envelope as EventEnvelope
    const payload = event.payload as { runId?: string; goalRevision?: number; cause?: string; to?: string; stopRun?: { runId: string } }
    if (event.eventType === "loopit.run.started") {
      const runId = payload.runId!
      let record = yield* get(runId)
      if (record) {
        if (record.eventId !== event.eventId || record.eventDigest !== digestOf(event)) return yield* Effect.fail(new Error("Run dispatch identity conflict"))
        return yield* observe(record)
      }
      const task = yield* delivery.getTask(event.aggregateId)
      const revision = task?.revisions[payload.goalRevision!]
      if (!revision?.frozen || !task?.runs[runId] || task.runs[runId].goalRevision !== payload.goalRevision)
        return yield* Effect.fail(new Error("Committed Run has no matching frozen goal revision"))
      const binding: Binding = { eventId: event.eventId, runId, taskId: event.aggregateId, goalRevision: payload.goalRevision!,
        handle: { attemptId: key("attempt", [runId, event.eventId]), operationId: key("runtime-start", event.eventId) } }
      const reservation = yield* transaction(Effect.gen(function* () {
        const existing = yield* get(runId)
        if (existing) return { record: existing, fresh: false }
        let input: StartInput | undefined, invalid: string | undefined
        const predecessors = (yield* db.select().from(DispatchTable).all()).map((row) => row.record as DispatchRecord)
          .filter((record) => record.taskId === binding.taskId && record.goalRevision === binding.goalRevision)
        try {
          const launch = options.launch(revision.goal, binding)
          if (launch.restrictedBinding) {
            const budget = launch.executionBudget
            if (!budget || budget.repairIndex !== revision.runIds.indexOf(runId)) throw new Error("Repair index must match committed GoalRevision Run count")
            const firstBudget = predecessors.find((record) => record.input?.executionBudget)?.input?.executionBudget
            if (firstBudget && budget.deadlineAt !== firstBudget.deadlineAt) throw new Error("GoalRevision deadline cannot be reset across Attempts")
            if (predecessors.some((record) => !record.input?.executionBudget)) throw new Error("Cannot add a new restricted budget to an existing unmetered revision")
          }
          input = buildStartInput(revision.goal, binding, launch, event.occurredAt)
        }
        catch (error) { invalid = errorOf(error).message }
        const candidate: DispatchRecord = { ...binding, eventDigest: digestOf(event), owner, createdAt: event.occurredAt,
          goalDigest: revision.goalDigest, phase: invalid ? "quarantined" : "reserved", input, ...(invalid ? { reason: invalid } : {}) }
        yield* db.insert(DispatchTable).values({ run_id: runId, event_id: event.eventId, attempt_id: binding.handle.attemptId,
          operation_id: binding.handle.operationId, record: candidate }).run().pipe(Effect.orDie)
        return { record: candidate, fresh: true }
      }))
      record = reservation.record
      if (!reservation.fresh) return yield* observe(record)
      return yield* dispatchReserved(record)
    }
    const runId = event.eventType === "loopit.goal.revised" ? payload.stopRun?.runId : payload.runId
    const reason = event.eventType === "loopit.goal.revised" && runId ? "cancel"
      : event.eventType === "loopit.run.transitioned" && payload.cause === "pauseRun" ? "pause"
      : event.eventType === "loopit.run.transitioned" && payload.cause === "cancelRun" ? "cancel" : undefined
    if (reason && runId) {
      const record = yield* get(runId)
      return record ? yield* stop(record, reason) : blocked(undefined, "No dispatch receipt exists; no process identity may be guessed")
    }
    if (event.eventType === "loopit.run.transitioned" && payload.cause === "resumeRun")
      return blocked(runId ? yield* get(runId) : undefined, "Resume requires independent safety reconciliation and a new Attempt; automatic redispatch disabled")
    return { kind: "ignored", gate: "not_evaluated" }
  })
  return Service.of({ get, consume, recoverPreparation, preparationHistory, confirmStopped, resumeStopped, controlHistory,
    inspect: (runId) => Effect.gen(function* () {
      yield* requireTopLevel
      const record = yield* get(runId)
      return record ? yield* observe(record) : blocked(undefined, "Run has no dispatch reservation")
    }),
    drain: (limit) => requireTopLevel.pipe(Effect.andThen(
      delivery.drainOutbox((item) => consume(item).pipe(Effect.asVoid, Effect.orDie), limit)), Effect.orDie),
  })
}))
export const layerFromPath = (filename: string, options: Options) => layerWith(options).pipe(Layer.provideMerge(Delivery.layerFromPath(filename)))
