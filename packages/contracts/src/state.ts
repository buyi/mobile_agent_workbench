import { Schema } from "effect"

// execution-contracts.md §4.1. Statuses and the legal Run transitions.

export const TaskStatus = Schema.Literals([
  "draft",
  "ready",
  "active",
  "paused",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
])
export type TaskStatus = typeof TaskStatus.Type
export const closedTaskStatuses: ReadonlySet<TaskStatus> = new Set(["succeeded", "failed", "cancelled", "superseded"])

export const RunStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "recovering",
  "verifying",
  "pausing",
  "paused",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
])
export type RunStatus = typeof RunStatus.Type
export const terminalRunStatuses: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled", "timed_out"])

export const StageRunStatus = Schema.Literals([
  "pending",
  "ready",
  "running",
  "paused",
  "passed",
  "failed",
  "blocked",
  "reused",
  "not_applicable",
  "cancelled",
])

// pausing/paused/cancelling are only left once the executor has verified the stop;
// an ACK alone never produces paused or cancelled.
export const runTransitions: Readonly<Record<RunStatus, ReadonlyArray<RunStatus>>> = {
  queued: ["running", "pausing", "cancelling", "failed", "timed_out"],
  running: ["verifying", "waiting", "recovering", "pausing", "cancelling", "failed", "timed_out"],
  verifying: ["running", "succeeded", "failed", "recovering", "pausing", "cancelling", "timed_out"],
  waiting: ["running", "recovering", "pausing", "cancelling", "timed_out"],
  recovering: ["running", "pausing", "cancelling", "failed", "timed_out"],
  pausing: ["paused", "cancelling", "timed_out"],
  paused: ["recovering", "cancelling"],
  cancelling: ["cancelled", "timed_out"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
}

export const canTransition = (from: RunStatus, to: RunStatus) => runTransitions[from].includes(to)

export const pausableRunStatuses: ReadonlySet<RunStatus> = new Set(["queued", "running", "waiting", "recovering", "verifying"])
