import {
  canTransition,
  checkFrozen,
  closedTaskStatuses,
  type Command,
  digestOf,
  type GoalSpec,
  pausableRunStatuses,
  type RunStatus,
  type TaskStatus,
  terminalRunStatuses,
  type Usage,
  validateGoal,
} from "@loopit/contracts"
import type { EventV2 } from "@opencode-ai/core/event"
import { GoalRevised, RunStarted, RunTransitioned, TaskCreated, type DeliveryEvent } from "./events"

// Deterministic task aggregate. `decide` turns a command into one event or a
// rejection; `evolve` is the only way state changes, for projection and replay alike.

export interface UsageTotals {
  readonly knownCostUsd: number
  readonly unknownCostReports: number
  readonly wallMs: number
  readonly humanInterventions: number
}

export interface RunState {
  readonly runId: string
  readonly goalRevision: number
  readonly status: RunStatus
  readonly priorRunId?: string
  readonly reason?: string
  readonly constraint?: string
  readonly supersedeOnStop?: boolean
  readonly usage: UsageTotals
  readonly history: ReadonlyArray<{ readonly from: RunStatus; readonly to: RunStatus; readonly at: string; readonly cause: string }>
}

export interface RevisionState {
  readonly revision: number
  readonly goal: GoalSpec
  readonly goalDigest: string
  readonly frozen: boolean
  readonly status: TaskStatus
  readonly successor?: number
  readonly runIds: ReadonlyArray<string>
  readonly usage: UsageTotals
}

export interface TaskState {
  readonly taskId: string
  readonly projectId: string
  /** Number of events applied; equals the client-visible aggregateVersion. */
  readonly version: number
  readonly currentRevision: number
  readonly revisions: Readonly<Record<number, RevisionState>>
  readonly runs: Readonly<Record<string, RunState>>
}

export const zeroUsage: UsageTotals = { knownCostUsd: 0, unknownCostReports: 0, wallMs: 0, humanInterventions: 0 }

const addUsage = (total: UsageTotals, usage?: Usage): UsageTotals =>
  usage
    ? {
        knownCostUsd: total.knownCostUsd + (usage.cost.known ? usage.cost.usd : 0),
        unknownCostReports: total.unknownCostReports + (usage.cost.known ? 0 : 1),
        wallMs: total.wallMs + usage.wallMs,
        humanInterventions: total.humanInterventions + usage.humanInterventions,
      }
    : total

export const taskStatus = (state: TaskState) => state.revisions[state.currentRevision].status

export type Decision =
  | { readonly ok: true; readonly definition: EventV2.Definition; readonly data: DeliveryEvent["data"] }
  | { readonly ok: false; readonly code: string; readonly message: string }

const reject = (code: string, message: string): Decision => ({ ok: false, code, message })
const accept = <D extends EventV2.Definition>(definition: D, data: EventV2.Data<D>): Decision =>
  ({ ok: true, definition, data }) as Decision

const userKinds = new Set(["user", "system"])
const executorKinds = new Set(["worker", "verifier", "system"])

function goalIssues(goal: GoalSpec) {
  const issues = validateGoal(goal)
  return issues.length > 0 ? reject("goal_invalid", issues.map((i) => `${i.code} at ${i.path}`).join("; ")) : undefined
}

export function decide(state: TaskState | undefined, command: Command, now: string): Decision {
  const meta = {
    taskId: command.taskId,
    commandId: command.commandId,
    causationId: command.commandId,
    correlationId: command.commandId,
    actor: command.actor,
    occurredAt: now,
  }

  if (command.type === "createTask") {
    if (state) return reject("task_exists", `Task ${command.taskId} already exists`)
    if (command.expectedVersion !== 0) return reject("version_conflict", `expected ${command.expectedVersion}, current 0`)
    if (!userKinds.has(command.actor.kind)) return reject("forbidden", `${command.actor.kind} cannot create tasks`)
    if (command.goal.taskId !== command.taskId || command.goal.goalRevision !== 1)
      return reject("revision_mismatch", "A new task starts at goalRevision 1 of the same taskId")
    const invalid = goalIssues(command.goal)
    if (invalid) return invalid
    return accept(TaskCreated, {
      ...meta,
      projectId: command.goal.projectId,
      goal: command.goal,
      goalDigest: digestOf(command.goal),
      frozen: checkFrozen(command.goal).length === 0,
    })
  }

  if (!state) return reject("task_not_found", `Task ${command.taskId} does not exist`)
  if (command.expectedVersion !== undefined && command.expectedVersion !== state.version)
    return reject("version_conflict", `expected ${command.expectedVersion}, current ${state.version}`)
  const current = state.revisions[state.currentRevision]

  if (command.type === "reviseGoal") {
    if (!userKinds.has(command.actor.kind)) return reject("forbidden", "Only users change goals and acceptance")
    if (
      command.goal.taskId !== state.taskId ||
      command.goal.projectId !== state.projectId ||
      command.goal.goalRevision !== state.currentRevision + 1
    )
      return reject("revision_mismatch", `Next revision must be ${state.currentRevision + 1} of ${state.taskId}`)
    const invalid = goalIssues(command.goal)
    if (invalid) return invalid
    const active = activeRun(state, current.revision)
    return accept(GoalRevised, {
      ...meta,
      goal: command.goal,
      goalDigest: digestOf(command.goal),
      frozen: checkFrozen(command.goal).length === 0,
      previousRevision: current.revision,
      ...(active ? { stopRun: { runId: active.runId, from: active.status } } : {}),
    })
  }

  if (command.type === "startRun") {
    if (!userKinds.has(command.actor.kind)) return reject("forbidden", `${command.actor.kind} cannot start runs`)
    if (state.runs[command.runId]) return reject("run_exists", `Run ${command.runId} already exists`)
    if (closedTaskStatuses.has(current.status))
      return reject("revision_closed", `Revision ${current.revision} is ${current.status}; revise the goal to continue`)
    if (!current.frozen)
      return reject("goal_not_frozen", checkFrozen(current.goal).map((i) => `${i.code} at ${i.path}`).join("; "))
    // Any revision's unfinished run may still own the workspace or a device.
    const active = Object.values(state.runs).find((run) => !terminalRunStatuses.has(run.status))
    if (active) return reject("run_active", `Run ${active.runId} is still ${active.status}`)
    const allowed = 1 + current.goal.budgets.maxRepairCycles
    if (current.runIds.length >= allowed)
      return reject("budget_exhausted", `Revision ${current.revision} used ${current.runIds.length}/${allowed} runs`)
    const prior = current.runIds.at(-1)
    return accept(RunStarted, {
      ...meta,
      runId: command.runId,
      goalRevision: current.revision,
      ...(prior ? { priorRunId: prior } : {}),
    })
  }

  const run = state.runs[command.runId]
  if (!run) return reject("run_not_found", `Run ${command.runId} does not exist on ${state.taskId}`)
  if (terminalRunStatuses.has(run.status))
    return reject("run_terminal", `Run ${run.runId} is ${run.status}; start a new run instead`)
  const transition = (to: RunStatus, reason: string, extra: Partial<EventV2.Data<typeof RunTransitioned>> = {}) =>
    accept(RunTransitioned, { ...meta, runId: run.runId, cause: command.type as any, from: run.status, to, reason, ...extra })

  switch (command.type) {
    case "pauseRun":
      if (!userKinds.has(command.actor.kind)) return reject("forbidden", `${command.actor.kind} cannot pause runs`)
      if (!pausableRunStatuses.has(run.status)) return reject("illegal_transition", `Cannot pause a ${run.status} run`)
      return transition("pausing", command.reason ?? "pause requested")
    case "cancelRun":
      if (!userKinds.has(command.actor.kind)) return reject("forbidden", `${command.actor.kind} cannot cancel runs`)
      if (!canTransition(run.status, "cancelling")) return reject("illegal_transition", `Cannot cancel a ${run.status} run`)
      return transition("cancelling", command.reason ?? "cancel requested")
    case "resumeRun":
      if (!userKinds.has(command.actor.kind)) return reject("forbidden", `${command.actor.kind} cannot resume runs`)
      if (run.status !== "paused") return reject("illegal_transition", `Cannot resume a ${run.status} run`)
      return transition("recovering", command.reason ?? "resume requested; reconcile before continuing")
    case "reportRun": {
      if (!executorKinds.has(command.actor.kind)) return reject("forbidden", "Only executors report run facts")
      // Reports acknowledge execution, but never replace a control command. In
      // particular a paused run stays paused across restarts until resumeRun or
      // cancelRun records a new authorized intent, even for a system reporter.
      if (run.status === "paused" || command.to === "pausing" || command.to === "cancelling")
        return reject("control_command_required", "Use pauseRun, cancelRun or resumeRun to change control intent")
      if (!canTransition(run.status, command.to))
        return reject("illegal_transition", `${run.status} -> ${command.to} is not allowed`)
      if ((command.to === "failed" || command.to === "timed_out") && command.closeRevision === undefined)
        return reject("close_revision_required", `${command.to} must state whether the revision closes`)
      if (command.to === "succeeded" && !command.gateRef)
        return reject("gate_required", "Success requires the delivery GateDecision that allows it")
      return transition(command.to, command.reason, {
        ...(command.closeRevision !== undefined ? { closeRevision: command.closeRevision } : {}),
        ...(command.gateRef ? { gateRef: command.gateRef } : {}),
        ...(command.constraint ? { constraint: command.constraint } : {}),
        ...(command.usage ? { usage: command.usage } : {}),
      })
    }
  }
}

function activeRun(state: TaskState, revision: number) {
  return state.revisions[revision].runIds.map((id) => state.runs[id]).find((run) => !terminalRunStatuses.has(run.status))
}

function revisionStatusAfter(run: RunState, closeRevision: boolean | undefined, current: TaskStatus): TaskStatus {
  switch (run.status) {
    case "paused":
      return "paused"
    case "waiting":
      return run.constraint ? "blocked" : "active"
    case "succeeded":
      return "succeeded"
    case "failed":
    case "timed_out":
      return closeRevision ? "failed" : "active"
    case "cancelled":
      return run.supersedeOnStop ? "superseded" : "cancelled"
    default:
      return closedTaskStatuses.has(current) ? current : "active"
  }
}

export function evolve(state: TaskState | undefined, event: DeliveryEvent): TaskState {
  const data = event.data
  if (event.type === TaskCreated.type) {
    const created = event.data as EventV2.Data<typeof TaskCreated>
    return {
      taskId: created.taskId,
      projectId: created.projectId,
      version: 1,
      currentRevision: 1,
      revisions: {
        1: {
          revision: 1,
          goal: created.goal,
          goalDigest: created.goalDigest,
          frozen: created.frozen,
          status: created.frozen ? "ready" : "draft",
          runIds: [],
          usage: zeroUsage,
        },
      },
      runs: {},
    }
  }
  if (!state) throw new Error(`${event.type} for unknown task ${data.taskId}`)
  const next = { ...state, version: state.version + 1 }

  if (event.type === GoalRevised.type) {
    const revised = data as EventV2.Data<typeof GoalRevised>
    const previous = state.revisions[revised.previousRevision]
    const runs = { ...state.runs }
    let previousStatus = previous.status
    if (revised.stopRun) {
      const run = runs[revised.stopRun.runId]
      runs[run.runId] = {
        ...run,
        status: run.status === "cancelling" ? run.status : "cancelling",
        reason: `superseded by revision ${revised.goal.goalRevision}`,
        supersedeOnStop: true,
        history: [...run.history, { from: run.status, to: "cancelling", at: revised.occurredAt, cause: "reviseGoal" }],
      }
    } else if (!closedTaskStatuses.has(previousStatus)) previousStatus = "superseded"
    return {
      ...next,
      currentRevision: revised.goal.goalRevision,
      runs,
      revisions: {
        ...state.revisions,
        [previous.revision]: { ...previous, status: previousStatus, successor: revised.goal.goalRevision },
        [revised.goal.goalRevision]: {
          revision: revised.goal.goalRevision,
          goal: revised.goal,
          goalDigest: revised.goalDigest,
          frozen: revised.frozen,
          status: revised.frozen ? "ready" : "draft",
          runIds: [],
          usage: zeroUsage,
        },
      },
    }
  }

  if (event.type === RunStarted.type) {
    const started = data as EventV2.Data<typeof RunStarted>
    const revision = state.revisions[started.goalRevision]
    return {
      ...next,
      runs: {
        ...state.runs,
        [started.runId]: {
          runId: started.runId,
          goalRevision: started.goalRevision,
          status: "queued",
          ...(started.priorRunId ? { priorRunId: started.priorRunId } : {}),
          usage: zeroUsage,
          history: [],
        },
      },
      revisions: {
        ...state.revisions,
        [revision.revision]: { ...revision, status: "active", runIds: [...revision.runIds, started.runId] },
      },
    }
  }

  const moved = data as EventV2.Data<typeof RunTransitioned>
  const before = state.runs[moved.runId]
  const run: RunState = {
    ...before,
    status: moved.to,
    reason: moved.reason,
    constraint: moved.to === "waiting" ? moved.constraint : undefined,
    usage: addUsage(before.usage, moved.usage),
    history: [...before.history, { from: moved.from, to: moved.to, at: moved.occurredAt, cause: moved.cause }],
  }
  const revision = state.revisions[run.goalRevision]
  return {
    ...next,
    runs: { ...state.runs, [run.runId]: run },
    revisions: {
      ...state.revisions,
      [revision.revision]: {
        ...revision,
        status: revisionStatusAfter(run, moved.closeRevision, revision.status),
        usage: addUsage(revision.usage, moved.usage),
      },
    },
  }
}
