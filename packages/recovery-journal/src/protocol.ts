import { Schema } from "effect"
import { Digest, Id, Ref } from "../../contracts/src/common"

const Counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const FenceSchema = Schema.Struct({ ownerId: Id, generation: Counter, epoch: Counter })
const DurableRefSchema = Schema.Struct({ ref: Ref, digest: Digest })
export const DispatchIntentSchema = Schema.Struct({
  scopeId: Id, operationId: Id, requestDigest: Digest, requestRef: DurableRefSchema,
  idempotencyKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  dispatchId: Id, fence: FenceSchema,
})
const Envelope = { schemaVersion: Schema.Literal("recovery-journal-request/1"), requestId: Id, journalId: Id }
export const RequestSchema = Schema.Union([
  Schema.Struct({ ...Envelope, method: Schema.Literal("currentAuthority"), scopeId: Id }),
  Schema.Struct({ ...Envelope, method: Schema.Literal("reserveDispatch"), intent: DispatchIntentSchema }),
])
export const AdminRequestSchema = Schema.Union([
  Schema.Struct({ ...Envelope, method: Schema.Literal("initializeScope"), scopeId: Id, fence: FenceSchema }),
  Schema.Struct({ ...Envelope, method: Schema.Literal("advanceFence"), scopeId: Id, expectedFence: FenceSchema, nextOwnerId: Id }),
])
export type Request = typeof RequestSchema.Type
export type AdminRequest = typeof AdminRequestSchema.Type
export const AuthorityProofSchema = Schema.Struct({ scopeId: Id, fence: FenceSchema, proof: DurableRefSchema })
export const JournalAckSchema = Schema.Struct({ intent: DispatchIntentSchema, durable: DurableRefSchema })
export const ResponseSchema = Schema.Union([
  Schema.Struct({ schemaVersion: Schema.Literal("recovery-journal-response/1"), requestId: Id, journalId: Id,
    ok: Schema.Literal(true), value: Schema.Union([AuthorityProofSchema, JournalAckSchema, Schema.Struct({ journalId: Id })]) }),
  Schema.Struct({ schemaVersion: Schema.Literal("recovery-journal-response/1"), requestId: Id, journalId: Id,
    ok: Schema.Literal(false), error: Schema.Struct({ code: Id }) }),
])
export type Response = typeof ResponseSchema.Type
export class JournalError extends Error { constructor(readonly code: string) { super(code) } }
export function decode<T>(schema: Schema.Codec<T, any, never, never>, value: unknown): T {
  try { return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" }) }
  catch { throw new JournalError("invalid_request") }
}
export const validPin = (ref: { ref: string; digest: string }) => !ref.ref.includes("#") || ref.ref.split("#")[1] === ref.digest
