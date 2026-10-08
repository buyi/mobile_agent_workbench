import { Schema } from "effect"
import { Actor, Digest, Id, NonEmptyString, NonNegativeInt, Ref, Timestamp, Usage } from "./common"
import { GoalSpec } from "./goal"
import { RunStatus } from "./state"

// main spec §3.1 / execution-contracts.md §8. Every mutation carries
// commandId + expectedVersion; a repeated commandId returns the same receipt.

const base = {
  schemaVersion: Schema.Literal("command/1"),
  commandId: Id,
  actor: Actor,
  issuedAt: Timestamp,
  taskId: Id,
}
const expectedVersion = NonNegativeInt

export const CreateTask = Schema.Struct({ ...base, type: Schema.Literal("createTask"), expectedVersion, goal: GoalSpec })
export const ReviseGoal = Schema.Struct({ ...base, type: Schema.Literal("reviseGoal"), expectedVersion, goal: GoalSpec })
export const StartRun = Schema.Struct({ ...base, type: Schema.Literal("startRun"), expectedVersion, runId: Id })
const control = { ...base, expectedVersion, runId: Id, reason: Schema.optionalKey(NonEmptyString) }
export const PauseRun = Schema.Struct({ ...control, type: Schema.Literal("pauseRun") })
export const CancelRun = Schema.Struct({ ...control, type: Schema.Literal("cancelRun") })
export const ResumeRun = Schema.Struct({ ...control, type: Schema.Literal("resumeRun") })

/** Executor-side fact report; expectedVersion is optional because workers retry on races. */
export const ReportRun = Schema.Struct({
  ...base,
  type: Schema.Literal("reportRun"),
  expectedVersion: Schema.optionalKey(NonNegativeInt),
  runId: Id,
  to: RunStatus,
  reason: NonEmptyString,
  // Required for failed/timed_out: false keeps the revision open for another Run.
  closeRevision: Schema.optionalKey(Schema.Boolean),
  // Required for succeeded: the delivery GateDecision that allows it.
  gateRef: Schema.optionalKey(Ref),
  constraint: Schema.optionalKey(NonEmptyString),
  usage: Schema.optionalKey(Usage),
})

export const Command = Schema.Union([CreateTask, ReviseGoal, StartRun, PauseRun, CancelRun, ResumeRun, ReportRun])
export type Command = typeof Command.Type
export type CommandType = Command["type"]

export const CommandReceipt = Schema.Struct({
  schemaVersion: Schema.Literal("receipt/1"),
  commandId: Id,
  commandType: Id,
  requestDigest: Digest,
  status: Schema.Literals(["accepted", "rejected"]),
  aggregateId: Id,
  aggregateVersion: NonNegativeInt,
  eventId: Schema.optionalKey(NonEmptyString),
  rejection: Schema.optionalKey(Schema.Struct({ code: Id, message: NonEmptyString })),
  recordedAt: Timestamp,
})
export type CommandReceipt = typeof CommandReceipt.Type
