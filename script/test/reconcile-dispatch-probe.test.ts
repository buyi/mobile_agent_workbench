import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { Effect } from "effect"
import { canTransition, digestOf, type GoalSpec } from "../../packages/contracts/src"
import { Delivery } from "../../packages/delivery/src"
import { reconciliationAuthority, reconciliationStopAuthority } from "../m0/reconcile-dispatch-probe"

test("shared pure stop-authority guard requires both accounts and three absent observations", () => {
  const active: any = { scopeId: "current", generation: 9, phase: "running", priorStopProofs: {
    scopeId: "previous", generation: 8, ...Object.fromEntries([["worker", 420, "loopit-worker"], ["signer", 421, "loopit-signer"]].map(([key, uid, account]) => [key, {
      schemaVersion: "worker-stop-proof/1", scopeId: "previous", generation: 8, serviceAccount: account, observedUid: uid, observedGid: 420, workerUid: 420,
      noLiveWorkerProcesses: true, userDomainAbsent: true, externalActionsVerified: false,
      observations: Array.from({ length: 3 }, () => ({ userDomainPresent: false, processes: [] })),
    }])) } }
  expect(reconciliationStopAuthority(active, "current", 9)).toEqual(active.priorStopProofs)
  for (const change of [(value: any) => value.priorStopProofs.signer.observedUid = 420,
    (value: any) => value.priorStopProofs.worker.observations.pop(), (value: any) => value.priorStopProofs.signer.observations[2].userDomainPresent = true,
    (value: any) => value.priorStopProofs.worker.observations[0].processes.push({ state: "S" }), (value: any) => value.phase = "stopped"]) {
    const altered = structuredClone(active); change(altered); expect(() => reconciliationStopAuthority(altered, "current", 9)).toThrow()
  }
})

test("only the exact queued ambiguous dispatch with its original budget can reconcile", () => {
  const binding = { taskId: "task", projectId: "project", goalRevision: 1, goalDigest: "goal", runId: "run", sourceDigest: "source", acceptanceDigest: "acceptance", criterionIds: ["M0-CODE-01"] }
  const budget = { deadlineAt: "unchanged", repairIndex: 1, maxRepairs: 3 }
  const task = { taskId: "task", projectId: "project", currentRevision: 1, revisions: { 1: { frozen: true, status: "active", goalDigest: "goal", runIds: ["run"] } } }
  const run = { taskId: "task", runId: "run", goalRevision: 1, status: "queued" }
  const dispatch = { ...binding, phase: "quarantined", reason: "dispatch failed or receipt lost; reconciliation required", input: { executionBudget: budget } }
  expect(() => reconciliationAuthority(task, run, dispatch, binding, budget)).not.toThrow()
  for (const changed of [{ ...dispatch, phase: "started" }, { ...dispatch, runId: "another" },
    { ...dispatch, reason: "runtime preparation failed; no new process dispatched" },
    { ...dispatch, input: { executionBudget: { ...budget, repairIndex: 0 } } }]) {
    expect(() => reconciliationAuthority(task, run, changed, binding, budget)).toThrow()
  }
  expect(() => reconciliationAuthority(task, { ...run, status: "running" }, dispatch, binding, budget)).toThrow()
})

test("formal Delivery queued-to-failed records unknown cost and retains active revision plus replay", async () => {
  const root = mkdtempSync("/private/tmp/loopit-reconcile-delivery-")
  try {
    const goal: GoalSpec = { schemaVersion: "goal/1", projectId: "reconcile-test", taskId: `reconcile-test-${randomUUID()}`, goalRevision: 1,
      objective: "Pure fixture for local reconciliation", scope: { repositoryRef: "fixture://local", baseRevision: "0".repeat(40), allowedPaths: ["sumEvenThrough.ts"], excluded: [] },
      acceptance: [{ id: "M0-CODE-01", expected: "Fixed checks", verification: "executable", evidenceKinds: ["fixture"], requiredAtStage: "verification" }],
      targetMatrix: [], delivery: { artifactKinds: ["candidate"] }, policyRef: "fixture://policy#sha256:" + "a".repeat(64),
      costBudgetRef: "fixture://cost#sha256:" + "b".repeat(64), budgets: { wallMinutes: 60, maxRepairCycles: 3, maxParallelWriters: 1 } }
    expect(canTransition("queued", "failed")).toBe(true)
    await Effect.runPromise(Effect.gen(function* () {
      const delivery = yield* Delivery.Service
      const command = (type: string, fields: object) => delivery.execute({ schemaVersion: "command/1", commandId: randomUUID(),
        actor: { kind: "system", id: "reconciliation-test" }, issuedAt: new Date().toISOString(), taskId: goal.taskId, type, ...fields })
      for (const response of [yield* command("createTask", { expectedVersion: 0, goal }), yield* command("startRun", { expectedVersion: 1, runId: "run-test" })])
        if (response.kind !== "receipt" || response.receipt.status !== "accepted") throw new Error(JSON.stringify(response))
      const result = yield* command("reportRun", { expectedVersion: 2, runId: "run-test", to: "failed", closeRevision: false,
        reason: "ambiguous dispatch reconciled stopped; model usage unknown",
        usage: { cost: { known: false, reason: "unknown dispatch" }, wallMs: 0, humanInterventions: 0 } })
      expect(result.kind === "receipt" && result.receipt.status).toBe("accepted")
      const task = yield* delivery.getTask(goal.taskId), run = yield* delivery.getRun("run-test")
      expect(run?.status).toBe("failed")
      expect(run?.usage.unknownCostReports).toBe(1)
      expect(task?.revisions[1].status).toBe("active")
      expect(digestOf(yield* delivery.replay(goal.taskId))).toBe(digestOf(task))
    }).pipe(Effect.provide(Delivery.layerFromPath(join(root, "delivery.sqlite"))), Effect.scoped))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
