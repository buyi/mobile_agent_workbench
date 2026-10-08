import { Schema } from "effect"
import { Actor, Id, NonEmptyString, NonNegativeInt, Ref, Timestamp } from "./common"

// execution-contracts.md §7.1. Clients order and dedupe by aggregateVersion,
// never by client clock.

export const EventEnvelope = Schema.Struct({
  schemaVersion: Schema.Literal("event/1"),
  eventId: NonEmptyString,
  aggregateId: Id,
  aggregateVersion: NonNegativeInt,
  eventType: NonEmptyString,
  eventSchemaVersion: NonNegativeInt,
  commandId: Id,
  causationId: Id,
  correlationId: Id,
  occurredAt: Timestamp,
  recordedAt: Timestamp,
  actor: Actor,
  payload: Schema.optionalKey(Schema.Unknown),
  payloadRef: Schema.optionalKey(Ref),
})
export type EventEnvelope = typeof EventEnvelope.Type
