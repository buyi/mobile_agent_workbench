import { Schema } from "effect"
import { Digest, Id, NonEmptyString, NonNegativeInt, Ref, Timestamp } from "./common"
import { SideEffectClass } from "./policy"

// execution-contracts.md §7.2. Record intent, then dispatch, then the receipt.
// A lost receipt is `indeterminate` and must be reconciled, never blindly redone.

export const OperationState = Schema.Literals([
  "intent_recorded",
  "dispatched",
  "succeeded",
  "failed",
  "indeterminate",
  "compensated",
])
export type OperationState = typeof OperationState.Type

export const OperationRecord = Schema.Struct({
  schemaVersion: Schema.Literal("operation/1"),
  operationId: Id,
  idempotencyKey: NonEmptyString,
  requestDigest: Digest,
  sideEffect: SideEffectClass,
  ownerGeneration: NonNegativeInt,
  recoveryEpoch: NonNegativeInt,
  state: OperationState,
  providerReceipt: Schema.optionalKey(Schema.Struct({ ref: Ref, digest: Digest })),
  externalResourceRef: Schema.optionalKey(Ref),
  reconcileMethod: Schema.Literals(["provider-query", "idempotent-retry", "supervisor-inspect", "none"]),
  lastObservedAt: Timestamp,
})
export type OperationRecord = typeof OperationRecord.Type

export const operationTransitions: Readonly<Record<OperationState, ReadonlyArray<OperationState>>> = {
  intent_recorded: ["dispatched", "failed"],
  dispatched: ["succeeded", "failed", "indeterminate"],
  // Only reconciliation facts leave indeterminate; never a fresh dispatch.
  indeterminate: ["succeeded", "failed", "compensated"],
  // A failure proven not to have executed may be redispatched under the same id.
  failed: ["dispatched"],
  succeeded: ["compensated"],
  compensated: [],
}

/** Whether an operation may be (re)dispatched automatically. */
export function mayDispatch(record: OperationRecord, current: { generation: number; epoch: number }) {
  if (record.ownerGeneration !== current.generation || record.recoveryEpoch !== current.epoch) return false
  if (record.state === "intent_recorded") return true
  return record.state === "failed" && record.reconcileMethod !== "none"
}
