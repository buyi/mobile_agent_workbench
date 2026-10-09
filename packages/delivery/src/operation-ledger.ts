import { randomUUID } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { digestOf, parse, type OperationRecord } from "@loopit/contracts"
import { databaseLayerFromPath, ensureDeliveryDurability } from "./database"
import { applyMigrations, AuthorityTable, OperationTable } from "./sql"

export interface Fence { ownerId: string; generation: number; epoch: number }
export interface DurableRef { ref: string; digest: string }
export interface AuthorityProof { scopeId: string; fence: Fence; proof: DurableRef }
export interface DispatchIntent {
  scopeId: string; operationId: string; requestDigest: string; requestRef: DurableRef; idempotencyKey: string; dispatchId: string; fence: Fence
}
export interface JournalAck { intent: DispatchIntent; durable: DurableRef }

/** Trusted integration port, never supplied by a model. A local/in-memory fake
 * cannot establish independent-fault-domain readiness for production. */
export interface RecoveryJournal {
  currentAuthority(scopeId: string): Effect.Effect<AuthorityProof, unknown>
  /** Atomically validate the live fence and reserve (scopeId, idempotencyKey),
   * permanently binding that logical identity to operationId and requestDigest.
   * Refuse changed IDs/digests and any second dispatch, including from an old
   * SQLite snapshot. A globally reused operationId must also be rejected.
   * Return only after the exact intent is durable outside that SQLite domain. */
  reserveDispatch(intent: DispatchIntent): Effect.Effect<JournalAck, unknown>
}
interface Authority extends AuthorityProof { mode: "ready" | "recovery_only" }
export interface Entry {
  scopeId: string
  ownerId: string
  requestRef: DurableRef
  record: OperationRecord
  phase: "intent" | "awaiting_journal" | "permitted" | "indeterminate" | "settled"
  dispatchId?: string
  journal?: JournalAck
  history: Array<{ at: string; action: string; fence: Fence; evidence?: DurableRef }>
}
export interface IntentInput { scopeId: string; ownerId: string; requestRef: DurableRef; record: OperationRecord }
export interface DispatchPermit { intent: DispatchIntent; journal: JournalAck }
export interface Outcome {
  state: "succeeded" | "failed" | "compensated"
  evidence: DurableRef
  externalResourceRef?: string
}
export class LedgerError extends Error {
  constructor(readonly code: string, message = code) { super(message) }
}
export interface Interface {
  activate(scopeId: string, fence: Fence): Effect.Effect<AuthorityProof, LedgerError>
  enterRecovery(scopeId: string): Effect.Effect<void, LedgerError>
  recordIntent(input: IntentInput): Effect.Effect<Entry, LedgerError>
  prepareDispatch(operationId: string, fence: Fence): Effect.Effect<DispatchPermit, LedgerError>
  recordReceipt(operationId: string, fence: Fence, outcome: Outcome): Effect.Effect<Entry, LedgerError>
  markIndeterminate(operationId: string, fence: Fence): Effect.Effect<Entry, LedgerError>
  reconcile(operationId: string, fence: Fence, outcome: Outcome): Effect.Effect<Entry, LedgerError>
  get(operationId: string): Effect.Effect<Entry | undefined>
}
export class Service extends Context.Service<Service, Interface>()("@loopit/delivery/OperationLedger") {}
export interface Options { journal?: RecoveryJournal; now?: () => string }
const sameFence = (a: Fence, b: Fence) => a.ownerId === b.ownerId && a.generation === b.generation && a.epoch === b.epoch
const fenceOf = (entry: Entry): Fence => ({ ownerId: entry.ownerId, generation: entry.record.ownerGeneration, epoch: entry.record.recoveryEpoch })
const validFence = (fence: Fence) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(fence.ownerId) &&
  [fence.generation, fence.epoch].every((n) => Number.isSafeInteger(n) && n >= 0)
const validRef = (ref: DurableRef) => /^[a-z][a-z0-9+.-]*:\/\/[^\s#]+(?:#sha256:[0-9a-f]{64})?$/.test(ref.ref) &&
  /^sha256:[0-9a-f]{64}$/.test(ref.digest) && (!ref.ref.includes("#") || ref.ref.slice(ref.ref.indexOf("#") + 1) === ref.digest)
const fail = (code: string, message?: string) => Effect.fail(new LedgerError(code, message))

export const layerWith = (options: Options = {}) => Layer.effect(Service, Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* ensureDeliveryDurability(db).pipe(Effect.orDie)
  yield* applyMigrations(db).pipe(Effect.orDie)
  const now = options.now ?? (() => new Date().toISOString())
  // A new process must contact the external authority even when SQLite says ready.
  const activated = new Map<string, Fence>()
  const read = (operationId: string) => db.select().from(OperationTable).where(eq(OperationTable.operation_id, operationId)).get().pipe(Effect.orDie)
  const authority = (scopeId: string) => db.select().from(AuthorityTable).where(eq(AuthorityTable.scope_id, scopeId)).get().pipe(
    Effect.orDie, Effect.map((row) => row?.authority as Authority | undefined))
  const write = (entry: Entry) => db.update(OperationTable).set({ entry }).where(eq(OperationTable.operation_id, entry.record.operationId)).run().pipe(Effect.orDie)
  const transact = <A>(body: Effect.Effect<A, LedgerError>) => db.transaction(() => body, { behavior: "immediate" }).pipe(
    Effect.catch((error) => error instanceof LedgerError ? Effect.fail(error) : Effect.die(error)))
  const localFence = (scopeId: string, fence: Fence) => Effect.gen(function* () {
    const current = yield* authority(scopeId)
    if (!current || current.mode !== "ready" || !activated.has(scopeId)) return yield* fail("recovery_only")
    if (!validFence(fence) || !sameFence(current.fence, fence) || !sameFence(activated.get(scopeId)!, fence)) return yield* fail("stale_fence")
    return current
  })
  const remoteFence = (scopeId: string, fence: Fence) => Effect.gen(function* () {
    if (!options.journal) return yield* fail("journal_unavailable")
    const proof = yield* options.journal.currentAuthority(scopeId).pipe(Effect.mapError(() => new LedgerError("authority_unavailable")))
    if (proof.scopeId !== scopeId || !validFence(proof.fence) || !validRef(proof.proof) || !sameFence(proof.fence, fence))
      return yield* fail("stale_fence")
    return proof
  })
  const get = (operationId: string) => read(operationId).pipe(Effect.map((row) => row?.entry as Entry | undefined))
  const requireEntry = (operationId: string) => Effect.gen(function* () {
    const entry = yield* get(operationId)
    return entry ?? (yield* fail("operation_not_found"))
  })
  const audit = (entry: Entry, action: string, fence: Fence, evidence?: DurableRef): Entry => ({
    ...entry, history: [...entry.history, { at: now(), action, fence, ...(evidence ? { evidence } : {}) }],
  })

  const activate = (scopeId: string, fence: Fence) => Effect.gen(function* () {
    const proof = yield* remoteFence(scopeId, fence)
    yield* transact(Effect.gen(function* () {
      const previous = yield* authority(scopeId)
      if (previous && (fence.epoch < previous.fence.epoch || (fence.epoch === previous.fence.epoch && fence.generation < previous.fence.generation)))
        return yield* fail("stale_fence")
      if (previous && !sameFence(previous.fence, fence) && fence.epoch === previous.fence.epoch && fence.generation === previous.fence.generation)
        return yield* fail("owner_changed_without_fence")
      yield* db.insert(AuthorityTable).values({ scope_id: scopeId, authority: { ...proof, mode: "ready" } }).onConflictDoUpdate({
        target: AuthorityTable.scope_id, set: { authority: { ...proof, mode: "ready" } },
      }).run().pipe(Effect.orDie)
      if (previous && !sameFence(previous.fence, fence)) {
        const rows = yield* db.select().from(OperationTable).where(eq(OperationTable.scope_id, scopeId)).all().pipe(Effect.orDie)
        for (const row of rows) {
          const entry = row.entry as Entry
          if (entry.record.state === "dispatched") yield* write(audit({ ...entry, phase: "indeterminate",
            record: { ...entry.record, state: "indeterminate", lastObservedAt: now() } }, "fence_changed", fence, proof.proof))
        }
      }
    }))
    activated.set(scopeId, fence)
    return proof
  })
  const enterRecovery = (scopeId: string) => transact(Effect.gen(function* () {
    const previous = yield* authority(scopeId)
    if (!previous) return yield* fail("scope_not_found")
    yield* db.update(AuthorityTable).set({ authority: { ...previous, mode: "recovery_only" } }).where(eq(AuthorityTable.scope_id, scopeId)).run().pipe(Effect.orDie)
    const rows = yield* db.select().from(OperationTable).where(eq(OperationTable.scope_id, scopeId)).all().pipe(Effect.orDie)
    for (const row of rows) {
      const entry = row.entry as Entry
      if (entry.record.state === "dispatched") yield* write(audit({ ...entry, phase: "indeterminate",
        record: { ...entry.record, state: "indeterminate", lastObservedAt: now() } }, "recovery_only", previous.fence))
    }
    activated.delete(scopeId)
  }))
  const recordIntent = (input: IntentInput) => Effect.gen(function* () {
    const parsed = parse("operation", input.record)
    if (!parsed.ok || input.record.state !== "intent_recorded" || input.record.providerReceipt || input.record.externalResourceRef ||
      !validRef(input.requestRef) || input.requestRef.digest !== input.record.requestDigest)
      return yield* fail("invalid_intent")
    const fence = { ownerId: input.ownerId, generation: input.record.ownerGeneration, epoch: input.record.recoveryEpoch }
    yield* remoteFence(input.scopeId, fence)
    const identity = digestOf({ scopeId: input.scopeId, operationId: input.record.operationId, idempotencyKey: input.record.idempotencyKey,
      requestDigest: input.record.requestDigest, requestRef: input.requestRef, sideEffect: input.record.sideEffect, reconcileMethod: input.record.reconcileMethod })
    return yield* transact(Effect.gen(function* () {
      yield* localFence(input.scopeId, fence)
      const stored = yield* read(input.record.operationId)
      if (stored) {
        if (stored.identity_digest !== identity) return yield* fail("operation_id_reused")
        return stored.entry as Entry
      }
      const logical = yield* db.select().from(OperationTable).where(and(eq(OperationTable.scope_id, input.scopeId),
        sql`json_extract(${OperationTable.entry}, '$.record.idempotencyKey') = ${input.record.idempotencyKey}`)).get().pipe(Effect.orDie)
      // A new operationId is not permission to repeat a logical side effect,
      // regardless of its last known outcome or of a changed request digest.
      if (logical) return yield* fail("idempotency_key_reused")
      const entry: Entry = { scopeId: input.scopeId, ownerId: input.ownerId, requestRef: input.requestRef, record: input.record, phase: "intent",
        history: [{ at: now(), action: "intent_recorded", fence }] }
      yield* db.insert(OperationTable).values({ operation_id: input.record.operationId, scope_id: input.scopeId, identity_digest: identity, entry }).run().pipe(Effect.orDie)
      return entry
    }))
  })
  const prepareDispatch = (operationId: string, fence: Fence) => Effect.gen(function* () {
    const before = yield* requireEntry(operationId)
    if (!validRef(before.requestRef) || before.requestRef.digest !== before.record.requestDigest) return yield* fail("invalid_intent")
    yield* remoteFence(before.scopeId, fence)
    const intent = yield* transact(Effect.gen(function* () {
      const entry = yield* requireEntry(operationId)
      yield* localFence(entry.scopeId, fence)
      if (!sameFence(fenceOf(entry), fence)) return yield* fail("stale_fence")
      if (entry.record.state !== "intent_recorded" || entry.dispatchId) return yield* fail("dispatch_requires_reconciliation")
      const intent: DispatchIntent = { scopeId: entry.scopeId, operationId, requestDigest: entry.record.requestDigest,
        requestRef: entry.requestRef, idempotencyKey: entry.record.idempotencyKey, dispatchId: randomUUID(), fence }
      yield* write(audit({ ...entry, dispatchId: intent.dispatchId, phase: "awaiting_journal",
        record: { ...entry.record, state: "dispatched", lastObservedAt: now() } }, "dispatch_reserved_locally", fence))
      return intent
    }))
    const acknowledgement = yield* Effect.suspend(() => options.journal!.reserveDispatch(intent)).pipe(Effect.exit)
    if (Exit.isFailure(acknowledgement)) {
      yield* setIndeterminate(operationId, fence)
      return yield* fail("journal_ack_unavailable")
    }
    const journal = acknowledgement.value
    if (digestOf(journal.intent) !== digestOf(intent) || !validRef(journal.durable) || journal.durable.digest !== digestOf(intent)) {
      yield* setIndeterminate(operationId, fence)
      return yield* fail("invalid_journal_ack")
    }
    // An acknowledgement may arrive after an external owner/epoch revocation.
    // Recheck before issuing the local permit; the actual connector must also
    // fence the side effect because any network check has a later race window.
    yield* remoteFence(before.scopeId, fence).pipe(Effect.catch((error) =>
      setIndeterminate(operationId, fence).pipe(Effect.andThen(Effect.fail(error)))))
    return yield* transact(Effect.gen(function* () {
      const entry = yield* requireEntry(operationId)
      yield* localFence(entry.scopeId, fence)
      if (entry.phase !== "awaiting_journal" || entry.dispatchId !== intent.dispatchId) return yield* fail("dispatch_requires_reconciliation")
      yield* write(audit({ ...entry, phase: "permitted", journal }, "journal_acknowledged", fence, journal.durable))
      return { intent, journal }
    }))
  })
  const setIndeterminate = (operationId: string, fence: Fence) => transact(Effect.gen(function* () {
    const entry = yield* requireEntry(operationId)
    yield* localFence(entry.scopeId, fence)
    if (!sameFence(fenceOf(entry), fence)) return yield* fail("stale_fence")
    if (entry.record.state === "indeterminate") return entry
    if (entry.record.state !== "dispatched") return yield* fail("illegal_transition")
    const next = audit({ ...entry, phase: "indeterminate", record: { ...entry.record, state: "indeterminate", lastObservedAt: now() } }, "outcome_unknown", fence)
    yield* write(next)
    return next
  }))
  const markIndeterminate = (operationId: string, fence: Fence) => Effect.gen(function* () {
    const entry = yield* requireEntry(operationId)
    yield* remoteFence(entry.scopeId, fence)
    return yield* setIndeterminate(operationId, fence)
  })
  const settle = (operationId: string, fence: Fence, outcome: Outcome, reconciliation: boolean) => Effect.gen(function* () {
    if (!validRef(outcome.evidence)) return yield* fail("evidence_required")
    const before = yield* requireEntry(operationId)
    yield* remoteFence(before.scopeId, fence)
    return yield* transact(Effect.gen(function* () {
      const entry = yield* requireEntry(operationId)
      yield* localFence(entry.scopeId, fence)
      if (!reconciliation && !sameFence(fenceOf(entry), fence)) return yield* fail("stale_fence")
      if (entry.phase === "settled") {
        if (entry.record.state === outcome.state && digestOf(entry.record.providerReceipt) === digestOf(outcome.evidence) &&
          entry.record.externalResourceRef === outcome.externalResourceRef) return entry
        return yield* fail("receipt_conflict")
      }
      if (reconciliation ? entry.record.state !== "indeterminate" : entry.phase !== "permitted") return yield* fail("illegal_transition")
      if (reconciliation && entry.record.reconcileMethod === "none") return yield* fail("reconciliation_unsupported")
      if (!reconciliation && outcome.state === "compensated") return yield* fail("illegal_transition")
      const record = { ...entry.record, ownerGeneration: fence.generation, recoveryEpoch: fence.epoch, state: outcome.state,
        providerReceipt: outcome.evidence, ...(outcome.externalResourceRef ? { externalResourceRef: outcome.externalResourceRef } : {}), lastObservedAt: now() }
      if (!parse("operation", record).ok) return yield* fail("invalid_receipt")
      const next = audit({ ...entry, ownerId: fence.ownerId, phase: "settled", record }, reconciliation ? "reconciled" : "receipt_recorded", fence, outcome.evidence)
      yield* write(next)
      return next
    }))
  })
  return Service.of({ activate, enterRecovery, recordIntent, prepareDispatch, markIndeterminate, get,
    recordReceipt: (id, fence, outcome) => settle(id, fence, outcome, false),
    reconcile: (id, fence, outcome) => settle(id, fence, outcome, true) })
}))

export const layerFromPath = (filename: string, options?: Options) => layerWith(options).pipe(Layer.provideMerge(databaseLayerFromPath(filename)))
