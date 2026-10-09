import { createHash } from "node:crypto"
import { digestOf } from "../../packages/contracts/src"
import type { ExecutionBudget } from "../../packages/runtime/src/restricted"
const sha = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`

export function openCodeProjectMarker(bytes: Buffer, baselineCommit: string) {
  if (!/^[a-f0-9]{40}$/.test(baselineCommit) || !bytes.equals(Buffer.from(baselineCommit)))
    throw new Error("opencode_project_marker_changed")
  return sha(bytes)
}
export function preparationStopAuthority(active: any, scopeId: string, generation: number) {
  const prior = active.priorStopProofs
  if (active.scopeId !== scopeId || active.generation !== generation || active.phase !== "running" ||
      !prior || !Number.isSafeInteger(prior.generation) || prior.generation >= generation || prior.scopeId === scopeId)
    throw new Error("prior_stop_authority_missing")
  for (const [key, uid, account] of [["worker", 420, "loopit-worker"], ["signer", 421, "loopit-signer"]] as const) {
    const proof = prior[key]
    if (!proof || proof.schemaVersion !== "worker-stop-proof/1" || proof.scopeId !== prior.scopeId || proof.generation !== prior.generation ||
        proof.serviceAccount !== account || proof.observedUid !== uid || proof.observedGid !== 420 || proof.workerUid !== 420 ||
        proof.noLiveWorkerProcesses !== true || proof.userDomainAbsent !== true || proof.externalActionsVerified !== false ||
        !Array.isArray(proof.observations) || proof.observations.length < 3 || proof.observations.slice(-3).some((item: any) =>
          item.userDomainPresent !== false || !Array.isArray(item.processes) || item.processes.some((process: any) => typeof process.state !== "string" || !process.state.startsWith("Z"))))
      throw new Error("prior_stop_authority_invalid")
  }
  return prior
}

/** A terminal failed Run is retained. Repairs are new Runs, never a rewrite of
 * failure history or a reset of the original GoalRevision deadline. */
export function repairRunAuthority(authorization: any, priorResult: any, task: any, nextRunId: string, budget: ExecutionBudget, now = Date.now()) {
  const revision = task?.revisions?.[task.currentRevision]
  const priorRun = task?.runs?.[authorization?.priorRunId]
  if (authorization?.schemaVersion !== "m0-control-repair/1" || authorization.nextRunId !== nextRunId ||
      authorization.priorRunId === nextRunId || task?.runs?.[nextRunId] || !revision || revision.status !== "active" ||
      priorRun?.status !== "failed" || revision.runIds.at(-1) !== authorization.priorRunId ||
      priorResult?.status !== "failed" || priorResult.binding?.runId !== authorization.priorRunId ||
      priorResult.binding?.goalDigest !== revision.goalDigest || priorResult.binding?.goalRevision !== task.currentRevision ||
      priorResult.binding?.taskId !== task.taskId || priorResult.binding?.projectId !== task.projectId ||
      budget.repairIndex !== revision.runIds.length || budget.repairIndex < 1 || budget.repairIndex > 3 ||
      budget.maxRepairs !== 3 || Date.parse(budget.deadlineAt) <= now || !Number.isFinite(Date.parse(budget.deadlineAt)) ||
      digestOf(authorization.budgetAfter) !== digestOf(budget) ||
      authorization.budgetBefore?.deadlineAt !== budget.deadlineAt || authorization.budgetBefore?.maxRepairs !== budget.maxRepairs ||
      authorization.budgetBefore?.repairIndex !== budget.repairIndex - 1)
    throw new Error("repair_run_authority_invalid")
  return authorization.priorRunId as string
}

