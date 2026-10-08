import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Stream } from "effect"
import { DeliveryEvents, DeliveryModel } from "../src"
import { cmd, exec, goal, tempDb, usage, withService } from "./helpers"
import { EventV2 } from "@opencode-ai/core/event"

const accepted = (r: { status: string; rejection?: { code: string } }) => expect(r.status, r.rejection?.code).toBe("accepted")
const rejected = (r: { status: string; rejection?: { code: string } }, code: string) => {
  expect(r.status).toBe("rejected")
  expect(r.rejection?.code).toBe(code)
}

describe("commands and receipts", () => {
  test("S01: the same createTask/startRun/cancelRun sent 10 times records one intent each", () =>
    withService(tempDb(), (s) =>
      Effect.gen(function* () {
        for (const command of [cmd.create(), cmd.start(1, "run-1"), cmd.cancel(2, "run-1")]) {
          const receipts = yield* Effect.all(
            Array.from({ length: 10 }, () => exec(s, command)),
            { concurrency: "unbounded" },
          )
          for (const r of receipts) expect(r).toEqual(receipts[0])
          accepted(receipts[0])
        }
        const read = yield* s.readEvents("task-1", 0)
        expect(read.mode === "delta" && read.events.map((e) => e.eventType)).toEqual([
          "loopit.task.created",
          "loopit.run.started",
          "loopit.run.transitioned",
        ])
      }),
    ))

  test("a reused commandId with a different request is refused, not applied", () =>
    withService(tempDb(), (s) =>
      Effect.gen(function* () {
        const first = cmd.create()
        accepted(yield* exec(s, first))
        rejected(yield* exec(s, { ...first, goal: goal({ objective: "something else" }) }), "command_id_reused")
        expect((yield* s.getTask("task-1"))?.revisions[1].goal.objective).toBe(goal().objective)
      }),
    ))

  test("schema-invalid input is rejected before any write", () =>
    withService(tempDb(), (s) =>
      Effect.gen(function* () {
        const bad = { ...cmd.create(), goal: { ...goal(), acceptance: [] } }
        const result = yield* s.execute(bad)
        expect(result.kind).toBe("invalid")
        expect(yield* s.getTask("task-1")).toBeUndefined()
        // The same commandId stays usable: nothing was recorded for it.
        accepted(yield* exec(s, { ...bad, goal: goal() }))
      }),
    ))

  test("S02: two revisions on the same expectedVersion: one wins, the other conflicts", () =>
    withService(tempDb(), (s) =>
      Effect.gen(function* () {
        accepted(yield* exec(s, cmd.create()))
        const [a, b] = yield* Effect.all([exec(s, cmd.revise(1, 2)), exec(s, cmd.revise(1, 2, { goal: goal({ goalRevision: 2, objective: "other" }) }))], {
          concurrency: "unbounded",
        })
        expect([a.status, b.status].sort()).toEqual(["accepted", "rejected"])
        rejected([a, b].find((r) => r.status === "rejected")!, "version_conflict")
        const task = (yield* s.getTask("task-1"))!
        expect(task.version).toBe(2)
        expect(task.revisions[1].status).toBe("superseded")
      }),
    ))

  test("a goal with placeholders stays draft and cannot start a run", () =>
    withService(tempDb(), (s) =>
      Effect.gen(function* () {
        const draft = goal({ scope: { ...goal().scope, allowedPaths: ["<confirmed-feature-scope>"] } })
        accepted(yield* exec(s, cmd.create({ goal: draft })))
        expect(DeliveryModel.taskStatus((yield* s.getTask("task-1"))!)).toBe("draft")
        rejected(yield* exec(s, cmd.start(1, "run-1")), "goal_not_frozen")
        expect((yield* s.getTask("task-1"))!.version).toBe(1)
      }),
    ))

  test("goal cross-field rules are enforced on createTask", () =>
    withService(tempDb(), (s) =>
      Effect.gen(function* () {
        const cyclic = goal()
        cyclic.acceptance[0].dependsOn = ["F2"]
        rejected(yield* exec(s, cmd.create({ goal: cyclic })), "goal_invalid")
      }),
    ))
})

describe("run lifecycle", () => {
  test("pause/cancel only finish when the executor confirms the stop; terminal runs never resume", () =>
    withService(tempDb(), (s) =>
      Effect.gen(function* () {
        accepted(yield* exec(s, cmd.create()))
        accepted(yield* exec(s, cmd.start(1, "run-1")))
        accepted(yield* exec(s, cmd.report("run-1", "running")))
        rejected(yield* exec(s, cmd.report("run-1", "paused")), "illegal_transition")
        accepted(yield* exec(s, cmd.pause(3, "run-1")))
        expect((yield* s.getRun("run-1"))?.status).toBe("pausing")
        expect(DeliveryModel.taskStatus((yield* s.getTask("task-1"))!)).toBe("active")
        rejected(yield* exec(s, cmd.pause(4, "run-1")), "illegal_transition")
        accepted(yield* exec(s, cmd.report("run-1", "paused")))
        expect(DeliveryModel.taskStatus((yield* s.getTask("task-1"))!)).toBe("paused")
        accepted(yield* exec(s, cmd.resume(5, "run-1")))
        expect((yield* s.getRun("run-1"))?.status).toBe("recovering")
        accepted(yield* exec(s, cmd.cancel(6, "run-1")))
        expect((yield* s.getRun("run-1"))?.status).toBe("cancelling")
        accepted(yield* exec(s, cmd.report("run-1", "cancelled")))
        rejected(yield* exec(s, cmd.resume(8, "run-1")), "run_terminal")
        expect(DeliveryModel.taskStatus((yield* s.getTask("task-1"))!)).toBe("cancelled")
        rejected(yield* exec(s, cmd.start(8, "run-2")), "revision_closed")
      }),
    ))

  test("only executors report facts, and success needs a delivery gate", () =>
    withService(tempDb(), (s) =>
      Effect.gen(function* () {
        accepted(yield* exec(s, cmd.create()))
        accepted(yield* exec(s, cmd.start(1, "run-1")))
        rejected(yield* exec(s, cmd.report("run-1", "running", { actor: { kind: "user", id: "owner" } })), "forbidden")
        rejected(yield* exec(s, { ...cmd.pause(2, "run-1"), actor: { kind: "worker", id: "w" } }), "forbidden")
        accepted(yield* exec(s, cmd.report("run-1", "running")))
        accepted(yield* exec(s, cmd.report("run-1", "verifying")))
        rejected(yield* exec(s, cmd.report("run-1", "succeeded")), "gate_required")
        rejected(yield* exec(s, cmd.report("run-1", "failed")), "close_revision_required")
        accepted(yield* exec(s, cmd.report("run-1", "succeeded", { gateRef: "gate://delivery/g-1" })))
        expect(DeliveryModel.taskStatus((yield* s.getTask("task-1"))!)).toBe("succeeded")
      }),
    ))

  test("M0-A14: retries accumulate budget; failed revisions keep their history when revised", () =>
    withService(tempDb(), (s) =>
      Effect.gen(function* () {
        accepted(yield* exec(s, cmd.create({ goal: goal({ budgets: { wallMinutes: 120, maxRepairCycles: 1, maxParallelWriters: 1 } }) })))
        accepted(yield* exec(s, cmd.start(1, "run-1")))
        accepted(yield* exec(s, cmd.report("run-1", "running", { usage: usage(1.5) })))
        accepted(yield* exec(s, cmd.report("run-1", "failed", { closeRevision: false, usage: usage("unknown") })))
        let task = (yield* s.getTask("task-1"))!
        expect(task.revisions[1].status).toBe("active")
        accepted(yield* exec(s, cmd.start(task.version, "run-2")))
        expect((yield* s.getRun("run-2"))?.priorRunId).toBe("run-1")
        accepted(yield* exec(s, cmd.report("run-2", "running", { usage: usage(2) })))
        accepted(yield* exec(s, cmd.report("run-2", "failed", { closeRevision: false })))
        task = (yield* s.getTask("task-1"))!
        // One run plus one repair cycle: the budget is spent, not reset by a new Run.
        rejected(yield* exec(s, cmd.start(task.version, "run-3")), "budget_exhausted")
        expect(task.revisions[1].usage).toEqual({ knownCostUsd: 3.5, unknownCostReports: 1, wallMs: 3000, humanInterventions: 0 })

        // Close the revision as failed, then revise: the failure stays a failure.
        const closeTask = (yield* s.getTask("task-1"))!
        accepted(yield* exec(s, cmd.revise(closeTask.version, 2)))
        task = (yield* s.getTask("task-1"))!
        expect(task.revisions[1].status).toBe("superseded")
      }),
    ))

  test("a closed failure is not rewritten as superseded by a later revision", () =>
    withService(tempDb(), (s) =>
      Effect.gen(function* () {
        accepted(yield* exec(s, cmd.create()))
        accepted(yield* exec(s, cmd.start(1, "run-1")))
        accepted(yield* exec(s, cmd.report("run-1", "running")))
        accepted(yield* exec(s, cmd.report("run-1", "failed", { closeRevision: true })))
        accepted(yield* exec(s, cmd.revise(4, 2)))
        const task = (yield* s.getTask("task-1"))!
        expect(task.revisions[1]).toMatchObject({ status: "failed", successor: 2 })
        expect(task.revisions[2].status).toBe("ready")
      }),
    ))

  test("revising while a run is active stops it first; superseded only after the stop is confirmed", () =>
    withService(tempDb(), (s) =>
      Effect.gen(function* () {
        accepted(yield* exec(s, cmd.create()))
        accepted(yield* exec(s, cmd.start(1, "run-1")))
        accepted(yield* exec(s, cmd.report("run-1", "running")))
        accepted(yield* exec(s, cmd.revise(3, 2)))
        let task = (yield* s.getTask("task-1"))!
        expect(task.runs["run-1"].status).toBe("cancelling")
        expect(task.revisions[1].status).toBe("active")
        // The old writer may still hold the workspace: no new run until it is confirmed stopped.
        rejected(yield* exec(s, cmd.start(4, "run-2")), "run_active")
        accepted(yield* exec(s, cmd.report("run-1", "cancelled")))
        task = (yield* s.getTask("task-1"))!
        expect(task.revisions[1].status).toBe("superseded")
        accepted(yield* exec(s, cmd.start(task.version, "run-2")))
        expect((yield* s.getRun("run-2"))?.goalRevision).toBe(2)
      }),
    ))
})

describe("events, projection and outbox", () => {
  const scenario = (s: Parameters<Parameters<typeof withService>[1]>[0]) =>
    Effect.gen(function* () {
      accepted(yield* exec(s, cmd.create()))
      accepted(yield* exec(s, cmd.start(1, "run-1")))
      accepted(yield* exec(s, cmd.report("run-1", "running", { usage: usage(0.25) })))
      accepted(yield* exec(s, cmd.pause(3, "run-1")))
      accepted(yield* exec(s, cmd.report("run-1", "paused")))
      accepted(yield* exec(s, cmd.revise(5, 2)))
    })

  test("S17: projection equals a replay of the event log", () =>
    withService(tempDb(), (s) =>
      Effect.gen(function* () {
        yield* scenario(s)
        expect(yield* s.replay("task-1")).toEqual(yield* s.getTask("task-1"))
      }),
    ))

  test("cursor reads page in order; a bad or missing cursor yields a snapshot", () =>
    withService(tempDb(), (s) =>
      Effect.gen(function* () {
        yield* scenario(s)
        const page = yield* s.readEvents("task-1", 2, 2)
        expect(page.mode === "delta" && page.events.map((e) => e.aggregateVersion)).toEqual([3, 4])
        expect(page.mode === "delta" && page.hasMore).toBe(true)
        const ahead = yield* s.readEvents("task-1", 99)
        expect(ahead.mode).toBe("snapshot")
        expect(ahead.cursor).toBe(6)
        expect((yield* s.readEvents("task-1")).mode).toBe("snapshot")
      }),
    ))

  test("watch replays from the cursor and then delivers new commits without gaps or duplicates", () =>
    withService(tempDb(), (s) =>
      Effect.gen(function* () {
        accepted(yield* exec(s, cmd.create()))
        accepted(yield* exec(s, cmd.start(1, "run-1")))
        const fiber = yield* s.watch("task-1", 1).pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped)
        yield* Effect.sleep("20 millis")
        accepted(yield* exec(s, cmd.report("run-1", "running")))
        accepted(yield* exec(s, cmd.pause(3, "run-1")))
        const seen = Array.from(yield* Fiber.join(fiber))
        expect(seen.map((e) => e.aggregateVersion)).toEqual([2, 3, 4])
      }),
    ))

  test("a failure inside the transaction leaves no event, receipt, projection or outbox row", () =>
    withService(tempDb(), (s) =>
      Effect.gen(function* () {
        accepted(yield* exec(s, cmd.create()))
        const events = yield* EventV2.Service
        yield* events.project(DeliveryEvents.RunStarted, () => Effect.die("injected projector failure"))
        const start = cmd.start(1, "run-1")
        const exit = yield* s.execute(start).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect((yield* s.getTask("task-1"))!.version).toBe(1)
        expect(yield* s.getRun("run-1")).toBeUndefined()
        const outbox: string[] = []
        yield* s.drainOutbox((item) => Effect.sync(() => outbox.push(item.envelope.eventType)))
        expect(outbox).toEqual(["loopit.task.created"])
      }),
    ))

  test("outbox delivers committed events in order and redelivers an unacknowledged one", () =>
    withService(tempDb(), (s) =>
      Effect.gen(function* () {
        yield* scenario(s)
        const seen: Array<[string, number]> = []
        const failing = yield* s
          .drainOutbox((item) =>
            item.envelope.aggregateVersion === 3 ? Effect.die("consumer crashed") : Effect.sync(() => seen.push([item.envelope.eventId, item.attempt])),
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(failing)).toBe(true)
        yield* s.drainOutbox((item) => Effect.sync(() => seen.push([item.envelope.eventId, item.attempt])))
        expect(seen.length).toBe(6)
        expect(seen[2][1]).toBe(2)
        expect(new Set(seen.map(([id]) => id)).size).toBe(6)
        expect(yield* s.drainOutbox(() => Effect.void)).toBe(0)
      }),
    ))
})
