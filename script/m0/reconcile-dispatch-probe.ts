/** Explicit local reconciliation of an ambiguous, stopped dispatch. No Runtime
 * is constructed, no outbox is drained and no reservation is released. */
import { Database as Sqlite } from "bun:sqlite"
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { checkFrozen, digestOf, parse } from "../../packages/contracts/src"
import { Delivery } from "../../packages/delivery/src"
import { byteDigest, type Binding } from "../../packages/verifier/src/service"
import type { ControlLoopSpec } from "./control-loop"
import { preparationStopAuthority } from "./control-loop-authority"
export { preparationStopAuthority as reconciliationStopAuthority } from "./control-loop-authority"

const FINAL = "/private/var/loopit/m0-runs/m0-code-loop-20261009a"
const AMBIGUOUS = "dispatch failed or receipt lost; reconciliation required"
export function reconciliationAuthority(task: any, run: any, dispatch: any, binding: Binding, budget: any) {
  const revision = task?.revisions?.[task.currentRevision]
  if (!task || task.taskId !== binding.taskId || task.projectId !== binding.projectId || task.currentRevision !== binding.goalRevision ||
      !revision?.frozen || revision.status !== "active" || revision.goalDigest !== binding.goalDigest || revision.runIds.at(-1) !== binding.runId ||
      run?.runId !== binding.runId || run.taskId !== binding.taskId || run.goalRevision !== binding.goalRevision || run.status !== "queued" ||
      dispatch?.phase !== "quarantined" || dispatch.reason !== AMBIGUOUS || dispatch.runId !== binding.runId || dispatch.taskId !== binding.taskId ||
      dispatch.goalRevision !== binding.goalRevision || dispatch.goalDigest !== binding.goalDigest || !dispatch.input ||
      digestOf(dispatch.input.executionBudget) !== digestOf(budget)) throw new Error("ambiguous_dispatch_authority_invalid")
}
function trusted(path: string) {
  if (realpathSync(path) !== path) throw new Error("noncanonical_trusted_path")
  for (let current = path; ; current = dirname(current)) {
    const info = lstatSync(current)
    if (info.uid !== 0 || info.mode & 0o022) throw new Error("unprotected_root_input")
    if (current === "/") break
  }
  const info = lstatSync(path)
  if (!info.isFile() || info.nlink !== 1) throw new Error("invalid_root_input")
  return readFileSync(path)
}
function pinned(value: { path: string; digest: string }) {
  const bytes = trusted(value.path)
  if (byteDigest(bytes) !== value.digest) throw new Error("input_pin_changed")
  return bytes
}
function save(path: string, value: unknown) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd) } finally { closeSync(fd) }
  const directory = openSync(dirname(path), constants.O_RDONLY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
}
function candidateDigest(path: string) {
  if (realpathSync(path) !== path) throw new Error("symbolic_candidate")
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.uid !== 420 || before.nlink !== 1 || before.size < 1 || before.size > 65536) throw new Error("invalid_candidate")
    const bytes = readFileSync(fd), after = fstatSync(fd)
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("candidate_changed")
    return byteDigest(bytes)
  } finally { closeSync(fd) }
}
async function main() {
  if (process.platform !== "darwin" || process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw new Error("root_controller_required")
  const args = new Map<string, string>()
  for (let index = 2; index < process.argv.length; index += 2) {
    if (!process.argv[index + 1] || args.has(process.argv[index])) throw new Error("invalid_arguments")
    args.set(process.argv[index], process.argv[index + 1])
  }
  const phase = args.get("--phase"), scopeId = args.get("--scope")!, generation = Number(args.get("--generation"))
  if (!["execute", "finalize"].includes(phase!) || !/^[a-f0-9-]{36}$/.test(scopeId) || !Number.isSafeInteger(generation) || generation < 1) throw new Error("invalid_scope")
  const lock = Number(process.env.LOOPIT_SUPERVISOR_LOCK_FD)
  if (!Number.isSafeInteger(lock) || lock < 3 || fstatSync(lock).uid !== 0 || !fstatSync(lock).isFile()) throw new Error("supervisor_ownership_required")
  const specPath = join(FINAL, "control/spec.json")
  if (args.get("--spec") !== specPath) throw new Error("fixed_spec_required")
  const spec = JSON.parse(trusted(specPath).toString()) as ControlLoopSpec
  if (spec.schemaVersion !== "m0-control-loop/1" || spec.jobId !== "m0-code-loop-20261009a" ||
      spec.controlDirectory !== join(FINAL, "control") || spec.workspace !== join(FINAL, "workspace")) throw new Error("fixed_job_required")
  const reports = join(spec.controlDirectory, "reports"), resultPath = join(reports, "result.json")
  const resultGoal = parse("goal", JSON.parse(pinned(spec.goal).toString()))
  if (!resultGoal.ok || checkFrozen(resultGoal.value).length || resultGoal.value.targetMatrix.length ||
      resultGoal.value.acceptance.length !== 1 || resultGoal.value.acceptance[0].id !== "M0-CODE-01") throw new Error("fixed_pure_fixture_goal_required")
  const goal = resultGoal.value
  pinned(spec.source); pinned(spec.tests)
  const binding: Binding = { projectId: goal.projectId, taskId: goal.taskId, goalRevision: goal.goalRevision, runId: spec.runId,
    goalDigest: digestOf(goal), sourceDigest: spec.source.digest, acceptanceDigest: digestOf(goal.acceptance), criterionIds: ["M0-CODE-01"] }
  if (phase === "finalize") {
    const proofPath = args.get("--stop-proof")
    if (proofPath !== `/private/var/loopit/supervisor/${scopeId}.stop.json`) throw new Error("fixed_stop_proof_required")
    const proof = JSON.parse(trusted(proofPath).toString()), result = JSON.parse(trusted(resultPath).toString())
    if (proof.scopeId !== scopeId || proof.generation !== generation || proof.workerUid !== 420 || proof.noLiveWorkerProcesses !== true ||
        proof.userDomainAbsent !== true || proof.externalActionsVerified !== false || result.scopeId !== scopeId || result.generation !== generation ||
        digestOf(result.binding) !== digestOf(binding) || result.status !== "failed" || result.reconciliation?.modelUsage !== "unknown")
      throw new Error("reconciliation_finalize_invalid")
    console.log(JSON.stringify({ status: "reconciled", report: resultPath, modelUsage: "unknown", externalActionsVerified: false }))
    return
  }
  const active = JSON.parse(trusted("/private/var/loopit/supervisor/active.json").toString())
  const priorStopProofs = preparationStopAuthority(active, scopeId, generation)
  const budgetRaw = trusted(join(spec.controlDirectory, "execution-budget.json")), budget = JSON.parse(budgetRaw.toString())
  const executionPath = join(reports, "execution.json")
  if (existsSync(executionPath) || existsSync(resultPath)) throw new Error("existing_reconciliation_reports_refused")
  const digest = candidateDigest(join(spec.workspace, "sumEvenThrough.ts"))
  const dbPath = join(spec.controlDirectory, "delivery.sqlite"); trusted(dbPath)
  const readDispatch = () => {
    const db = new Sqlite(dbPath, { readonly: true, create: false })
    try {
      const row = db.query("SELECT record FROM loopit_worker_dispatch WHERE run_id = ?").get(spec.runId) as { record: string } | null
      if (!row) throw new Error("dispatch_record_missing")
      return row.record
    } finally { db.close() }
  }
  const dispatchRaw = readDispatch(), dispatch = JSON.parse(dispatchRaw)
  const reconciliation = { kind: "ambiguous-dispatch-reconciled-stopped", priorStopProofs, modelUsage: "unknown", externalActionsVerified: false,
    scope: "Exclusive local service UIDs observed stopped for this pure fixture; no assertion of zero external effects", dispatchRecordDigest: byteDigest(dispatchRaw) }
  await Effect.runPromise(Effect.gen(function* () {
    const delivery = yield* Delivery.Service
    const taskBefore = yield* delivery.getTask(goal.taskId), runBefore = yield* delivery.getRun(spec.runId)
    reconciliationAuthority(taskBefore, runBefore, dispatch, binding, budget)
    save(executionPath, { scopeId, generation, binding, dispatch, reconciliation })
    const response = yield* delivery.execute({ schemaVersion: "command/1", type: "reportRun", commandId: randomUUID(),
      actor: { kind: "system", id: "m0-supervisor-reconciliation" }, issuedAt: new Date().toISOString(),
      taskId: goal.taskId, runId: spec.runId, expectedVersion: taskBefore!.version, to: "failed", closeRevision: false,
      reason: "ambiguous dispatch reconciled stopped; model usage unknown; no assertion of zero external effects",
      usage: { cost: { known: false, reason: "Dispatch receipt lost; model usage and billing remain unknown" }, wallMs: 0, humanInterventions: 0 } })
    if (response.kind !== "receipt" || response.receipt.status !== "accepted") throw new Error("reconciliation_transition_rejected")
    const task = yield* delivery.getTask(goal.taskId), run = yield* delivery.getRun(spec.runId), replay = yield* delivery.replay(goal.taskId)
    if (run?.status !== "failed" || task?.revisions[task.currentRevision]?.status !== "active" || digestOf(task) !== digestOf(replay)) throw new Error("reconciliation_projection_mismatch")
    if (readDispatch() !== dispatchRaw || !trusted(join(spec.controlDirectory, "execution-budget.json")).equals(budgetRaw)) throw new Error("reconciliation_state_changed")
    save(resultPath, { schemaVersion: "m0-control-loop-result/1", status: "failed", scopeId, generation, binding, candidateDigest: digest,
      task, run, usage: { status: "unknown", reason: "Ambiguous dispatch has no reliable execution receipt" }, reconciliation,
      eventReplayMatches: true, milestonePassed: false, m1FeatureImplemented: false })
    console.log(JSON.stringify({ status: "reconciled-awaiting-stop-proof", report: resultPath, modelUsage: "unknown" }))
  }).pipe(Effect.provide(Delivery.layerFromPath(dbPath)), Effect.scoped))
}
if (import.meta.main) main().catch((error) => { console.error(JSON.stringify({ status: "blocked", reason: error instanceof Error ? error.message : "reconciliation_failed" })); process.exitCode = 2 })
