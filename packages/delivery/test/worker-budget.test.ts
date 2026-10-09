import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { digestOf } from "@loopit/contracts"
import { WorkerDispatch } from "../src"
import { cmd, exec, goal } from "./helpers"
import { setup, withWorker } from "./worker-fixture"

const binding: WorkerDispatch.Binding = { eventId: "event-budget", runId: "run-budget", taskId: "task-1", goalRevision: 1,
  handle: { attemptId: "attempt-budget", operationId: "operation-budget" } }
const restrictedBinding = { configDigest: digestOf("host public config"), permissionDigest: digestOf("exact paths") }
const budget = (repairIndex = 0, deadlineAt = new Date(Date.now() + 30_000).toISOString()) => ({ deadlineAt, repairIndex, maxRepairs: 3 as const })

describe("trusted restricted launch budget bindings", () => {
  test("context presents elapsed absolute wall budget without renewing the frozen execution allowance", () => {
    const f = setup(), now = Date.now(), deadlineAt = new Date(now + 20 * 60_000).toISOString()
    const launch = { ...f.launch, wallMinutes: 60, restrictedBinding, executionBudget: budget(0, deadlineAt) }
    const old = WorkerDispatch.buildStartInput(goal(), binding, launch, new Date(now - 20 * 60_000).toISOString())
    const recovered = WorkerDispatch.buildStartInput(goal(), binding, launch, new Date(now).toISOString())
    expect(old.context.budget.wallMinutesRemaining).toBe(40)
    expect(recovered.context.budget.wallMinutesRemaining).toBe(20)
    expect(recovered.executionBudget).toEqual(old.executionBudget)
    expect(recovered.spec.budget).toEqual(old.spec.budget)
  })

  test("ContextManifest binds fixed host config and absolute budget without credentials", () => {
    const f = setup(), launch = { ...f.launch, restrictedBinding, executionBudget: budget() }
    const input = WorkerDispatch.buildStartInput(goal(), binding, launch, new Date().toISOString())
    expect(input.context.effectiveConfig.find((entry) => entry.ref === "config://opencode-restricted")?.digest).toBe(restrictedBinding.configDigest)
    expect(input.context.effectiveConfig.find((entry) => entry.ref === "config://execution-budget")?.digest).toBe(digestOf(launch.executionBudget))
    expect(input.spec.contextManifest.digest).toBe(digestOf(input.context))
    expect(input.executionBudget).toEqual(launch.executionBudget)
    expect(JSON.stringify(input)).not.toContain("oauthAccess")
    expect(() => WorkerDispatch.buildStartInput(goal(), binding, { ...launch, executionBudget: undefined }, new Date().toISOString())).toThrow("absolute")
    expect(() => WorkerDispatch.buildStartInput(goal(), binding, { ...launch, executionBudget: budget(4) }, new Date().toISOString())).toThrow("three-repair")
    expect(() => WorkerDispatch.buildStartInput(goal(), binding, launch, new Date(Date.now() - 3_600_000).toISOString())).toThrow("frozen goal")
  })

  test("SQLite reservation preserves the first deadline across reopening and rejects repair-index substitution", async () => {
    const f = setup(), firstDeadline = new Date(Date.now() + 30_000).toISOString()
    // This fake stops at the adapter port. The test proves real SQLite budget
    // admission only, and does not claim root identity or restricted execution.
    let prepares = 0
    f.adapter.prepareStart = async () => { prepares++; throw new Error("fixture: no model/privileged dispatch") }
    await withWorker(f.file, { adapter: f.adapter, launch: () => ({ ...f.launch, restrictedBinding, executionBudget: budget(0, firstDeadline) }) },
      (worker, delivery) => Effect.gen(function* () {
        yield* exec(delivery, cmd.create())
        yield* exec(delivery, cmd.start(1, "budget-run-1"))
        yield* worker.drain()
        expect((yield* worker.get("budget-run-1"))!.input!.executionBudget!.deadlineAt).toBe(firstDeadline)
        yield* exec(delivery, cmd.report("budget-run-1", "failed", { closeRevision: false }))
      }))
    expect(prepares).toBe(1)
    await withWorker(f.file, { adapter: f.adapter, launch: () => ({ ...f.launch, restrictedBinding, executionBudget: budget(1, new Date(Date.parse(firstDeadline) + 1000).toISOString()) }) },
      (worker, delivery) => Effect.gen(function* () {
        yield* exec(delivery, cmd.start((yield* delivery.getTask("task-1"))!.version, "budget-run-2"))
        yield* worker.drain()
        const second = (yield* worker.get("budget-run-2"))!
        expect(second.phase).toBe("quarantined")
        expect(second.reason).toContain("cannot be reset")
        yield* exec(delivery, cmd.report("budget-run-2", "failed", { closeRevision: false }))
      }))
    await withWorker(f.file, { adapter: f.adapter, launch: () => ({ ...f.launch, restrictedBinding, executionBudget: budget(0, firstDeadline) }) },
      (worker, delivery) => Effect.gen(function* () {
        yield* exec(delivery, cmd.start((yield* delivery.getTask("task-1"))!.version, "budget-run-3"))
        yield* worker.drain()
        expect((yield* worker.get("budget-run-3"))!.reason).toContain("Run count")
      }))
    expect(prepares).toBe(1)
  })
})
