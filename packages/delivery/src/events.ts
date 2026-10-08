import { Schema } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { Event } from "@opencode-ai/schema/event"
import { Actor, Digest, GoalSpec, Id, NonEmptyString, PositiveInt, Ref, RunStatus, Timestamp, Usage } from "@loopit/contracts"

// One accepted command produces exactly one durable event on the task aggregate.
// Each event records the decision already taken, so replay never re-decides.

const meta = {
  taskId: Id,
  commandId: Id,
  causationId: Id,
  correlationId: Id,
  actor: Actor,
  occurredAt: Timestamp,
}
const durable = { version: 1, aggregate: "taskId" }

export const TaskCreated = EventV2.define({
  type: "loopit.task.created",
  durable,
  schema: { ...meta, projectId: Id, goal: GoalSpec, goalDigest: Digest, frozen: Schema.Boolean },
})

export const GoalRevised = EventV2.define({
  type: "loopit.goal.revised",
  durable,
  schema: {
    ...meta,
    goal: GoalSpec,
    goalDigest: Digest,
    frozen: Schema.Boolean,
    previousRevision: PositiveInt,
    // Set when a writer still runs the previous revision: it is stopped first and
    // the old revision only becomes superseded once the stop is confirmed.
    stopRun: Schema.optionalKey(Schema.Struct({ runId: Id, from: RunStatus })),
  },
})

export const RunStarted = EventV2.define({
  type: "loopit.run.started",
  durable,
  schema: { ...meta, runId: Id, goalRevision: PositiveInt, priorRunId: Schema.optionalKey(Id) },
})

export const RunTransitioned = EventV2.define({
  type: "loopit.run.transitioned",
  durable,
  schema: {
    ...meta,
    runId: Id,
    cause: Schema.Literals(["pauseRun", "cancelRun", "resumeRun", "reportRun"]),
    from: RunStatus,
    to: RunStatus,
    reason: NonEmptyString,
    closeRevision: Schema.optionalKey(Schema.Boolean),
    gateRef: Schema.optionalKey(Ref),
    constraint: Schema.optionalKey(NonEmptyString),
    usage: Schema.optionalKey(Usage),
  },
})

export const definitions = [TaskCreated, GoalRevised, RunStarted, RunTransitioned] as const
export type DeliveryEvent =
  | EventV2.Payload<typeof TaskCreated>
  | EventV2.Payload<typeof GoalRevised>
  | EventV2.Payload<typeof RunStarted>
  | EventV2.Payload<typeof RunTransitioned>

export const manifest = {
  definitions: Event.durable(definitions),
  schema: Schema.Union(definitions),
}
