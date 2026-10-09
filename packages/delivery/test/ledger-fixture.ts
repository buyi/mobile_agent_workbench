import { Effect } from "effect"
import { digestOf, type OperationRecord } from "@loopit/contracts"
import { OperationLedger as Ledger } from "../src"

export const initialFence: Ledger.Fence = { ownerId: "worker-1", generation: 1, epoch: 1 }
export const scopeId = "release-channel-1"
export const intent = (patch: Partial<OperationRecord> = {}): Ledger.IntentInput => {
  const record: OperationRecord = { schemaVersion: "operation/1", operationId: "operation-1", idempotencyKey: "artifact-1:channel-1",
    requestDigest: digestOf({ candidate: "candidate-1", target: "channel-1" }), sideEffect: "reconcile_required", ownerGeneration: 1,
    recoveryEpoch: 1, state: "intent_recorded", reconcileMethod: "provider-query", lastObservedAt: new Date().toISOString(), ...patch }
  return { scopeId, ownerId: initialFence.ownerId, record, requestRef: { ref: "fixture://immutable-request/1", digest: record.requestDigest } }
}
export const outcome: Ledger.Outcome = { state: "succeeded", evidence: { ref: "fixture://provider-receipt/1", digest: digestOf("provider-receipt") }, externalResourceRef: "fixture://external-build/1" }

/** TEST ONLY: this in-memory journal has no independent durability guarantee. */
export class FakeJournal implements Ledger.RecoveryJournal {
  fence = initialFence
  mode: "grant" | "unavailable" | "invalid" = "grant"
  readonly reserved = new Map<string, Ledger.JournalAck>()
  private readonly operationIds = new Map<string, string>()
  currentAuthority(id: string) {
    return Effect.succeed({ scopeId: id, fence: this.fence, proof: { ref: "fixture://authority/current", digest: digestOf(this.fence) } })
  }
  reserveDispatch(value: Ledger.DispatchIntent) {
    return Effect.gen({ self: this }, function* () {
      if (this.mode === "unavailable") return yield* Effect.fail(new Error("journal unavailable"))
      if (digestOf(value.fence) !== digestOf(this.fence)) return yield* Effect.fail(new Error("stale external fence"))
      const logical = JSON.stringify([value.scopeId, value.idempotencyKey])
      if (this.operationIds.has(value.operationId) && this.operationIds.get(value.operationId) !== logical)
        return yield* Effect.fail(new Error("operation ID already belongs to another logical operation"))
      const previous = this.reserved.get(logical)
      if (previous && digestOf(previous.intent) !== digestOf(value)) return yield* Effect.fail(new Error("already reserved outside SQLite"))
      const ack = previous ?? { intent: value, durable: { ref: `fixture://independent-journal/${value.dispatchId}`, digest: digestOf(value) } }
      this.reserved.set(logical, ack)
      this.operationIds.set(value.operationId, logical)
      return this.mode === "invalid" ? { ...ack, durable: { ...ack.durable, digest: digestOf("different intent") } } : ack
    })
  }
}
export const withLedger = <A>(file: string, journal: Ledger.RecoveryJournal | undefined, body: (service: Ledger.Interface) => Effect.Effect<A, unknown, any>) =>
  Effect.runPromise(Effect.gen(function* () { return yield* body(yield* Ledger.Service) }).pipe(
    Effect.provide(Ledger.layerFromPath(file, { journal })), Effect.scoped) as Effect.Effect<A>)
