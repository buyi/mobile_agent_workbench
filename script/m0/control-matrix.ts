/** Deployed A05/A06 protocol experiment: trusted unbilled fixture, real Delivery,
 * Runtime, SQLite and Supervisor. Never uses a model, device or network client. */
import { createHash, randomUUID } from "node:crypto"
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Exit } from "effect"
import { checkFrozen, digestOf, parse, type GoalSpec } from "../../packages/contracts/src"
import { Delivery, WorkerDispatch } from "../../packages/delivery/src"
import { OpenCodeCli, restrictedConfigBinding, type ExecutionBudget, type RestrictedConfig } from "../../packages/runtime/src"
import { controlMatrixProofs, controlMatrixResumeAuthority } from "./control-matrix-authority"
import { readFreshFixtureReceipt } from "./control-matrix-receipt"

type Pin = { path: string; digest: string }
export interface ControlMatrixSpec {
  schemaVersion: "m0-control-matrix/1"; jobId: string; runId: string
  bun: Pin; executable: Pin & { version: string }; wrapper: Pin; catalog: Pin; goal: Pin
  workspace: string; runtimeDirectory: string; controlDirectory: string
  protectedRunFiles: Pin[]
}
const sha = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"))
function protectedPath(path: string) {
  if (realpathSync(path) !== path) throw new Error("matrix_noncanonical_input")
  for (let at = path; ; at = dirname(at)) {
    const st = lstatSync(at)
    if (st.uid !== 0 || (st.mode & 0o022)) throw new Error("matrix_unprotected_input")
    if (at === "/") break
  }
}
function save(path: string, value: unknown) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd) } finally { closeSync(fd) }
  const directory = openSync(dirname(path), constants.O_RDONLY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
}
async function main() {
  if (process.platform !== "darwin" || process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw new Error("root_matrix_controller_required")
  const args = new Map<string, string>()
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!process.argv[i + 1] || args.has(process.argv[i]) || !["--phase", "--spec", "--scope", "--generation", "--stop-proof"].includes(process.argv[i])) throw new Error("invalid_arguments")
    args.set(process.argv[i], process.argv[i + 1])
  }
  const phase = args.get("--phase"), scopeId = args.get("--scope")!, generation = Number(args.get("--generation"))
  if (!["execute", "finalize"].includes(phase!) || !/^[a-f0-9-]{36}$/.test(scopeId) || !Number.isSafeInteger(generation) || generation < 1) throw new Error("invalid_scope")
  const lock = Number(process.env.LOOPIT_SUPERVISOR_LOCK_FD)
  if (!Number.isSafeInteger(lock) || lock < 3 || !fstatSync(lock).isFile() || fstatSync(lock).uid !== 0) throw new Error("supervisor_lock_missing")
  protectedPath(args.get("--spec")!)
  const spec = read(args.get("--spec")!) as ControlMatrixSpec
  if (spec.schemaVersion !== "m0-control-matrix/1") throw new Error("invalid_matrix_spec")
  for (const pin of [spec.bun, spec.executable, spec.wrapper, spec.catalog, spec.goal]) {
    protectedPath(pin.path); if (sha(readFileSync(pin.path)) !== pin.digest) throw new Error("matrix_pin_changed")
  }
  const verifyPriorRunPins = () => {
    if (spec.protectedRunFiles.length < 2) throw new Error("prior_run_pins_missing")
    for (const pin of spec.protectedRunFiles) {
      protectedPath(pin.path)
      if (sha(readFileSync(pin.path)) !== pin.digest) throw new Error("prior_run_evidence_changed")
    }
    return spec.protectedRunFiles
  }
  verifyPriorRunPins()
  protectedPath(spec.controlDirectory)
  const goalCheck = parse("goal", read(spec.goal.path))
  if (!goalCheck.ok || checkFrozen(goalCheck.value).length) throw new Error("matrix_goal_invalid")
  const goal: GoalSpec = goalCheck.value
  const reports = join(spec.controlDirectory, "reports"); mkdirSync(reports, { recursive: true, mode: 0o700 })
  const active = () => { const path = "/private/var/loopit/supervisor/active.json"; protectedPath(path); return read(path) }
  const budgetPath = join(spec.controlDirectory, "execution-budget.json")
  if (!existsSync(budgetPath)) {
    if (phase !== "execute") throw new Error("matrix_budget_missing")
    save(budgetPath, { deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(), repairIndex: 0, maxRepairs: 3 })
  }
  const budget = read(budgetPath) as ExecutionBudget
  const restricted: RestrictedConfig = { readPaths: ["fixture.txt"], editPaths: ["fixture.txt"], agent: { name: "matrix-fixture", steps: 1 },
    model: { provider: "openai", model: "unbilled-fixture", variant: "low" }, catalog: spec.catalog,
    oauthAccess: async () => ({ access: "NO_MODEL_FIXTURE_CREDENTIAL", expiresAt: Date.now() + 60 * 60_000 }),
    isolation: { runtimeDirectory: spec.runtimeDirectory, identityRuntime: spec.bun, childIdentity: { uid: 420, gid: 420 }, admission: { scopeId, generation },
      launcher: { argvPrefix: ["/usr/bin/python3", spec.wrapper.path, "--uid", "420", "--gid", "420", "--"], wrapperPath: spec.wrapper.path, wrapperDigest: spec.wrapper.digest },
      denyRead: [spec.controlDirectory, "/private/var/loopit/signer"], proxyPort: 1 } }
  const adapter = new OpenCodeCli({ executable: spec.executable.path, executableDigest: spec.executable.digest, version: spec.executable.version,
    stateDirectory: join(spec.controlDirectory, "runtime-state"), restricted, logLimitBytes: 65536 })
  let prepareCalls = 0, denyHostProof = false, rejectedHostProofs = 0
  const nativePrepare = adapter.prepareStart.bind(adapter)
  adapter.prepareStart = async (...args) => { prepareCalls++; return nativePrepare(...args) }
  const pausePath = join(reports, "pause-finalized.json"), executePath = join(reports, `execute-${scopeId}.json`)
  let releaseReceipt: any
  const verifyStopped: NonNullable<WorkerDispatch.Options["verifyStopped"]> = async (request) => {
    if (denyHostProof) { rejectedHostProofs++; throw new Error("matrix_injected_host_proof_unavailable") }
    const current = active()
    let pair: any
    if (request.mode === "stop") {
      pair = controlMatrixProofs(current, scopeId, generation)
      const execution = read(executePath)
      if (execution.operationId !== request.record.handle.operationId || execution.controlEventId !== request.controlEvent.eventId ||
          execution.taskId !== request.record.taskId || execution.runId !== request.record.runId ||
          request.authorization.stopProofDigest !== digestOf({ pair, execution })) throw new Error("matrix_stop_binding_mismatch")
    } else {
      const saved = read(pausePath)
      controlMatrixResumeAuthority(current, scopeId, generation, saved)
      pair = saved.authority.pair
      if (digestOf(saved.record.handle) !== digestOf(request.record.handle) || saved.record.input.spec.contextManifest.digest !== request.record.input?.spec.contextManifest.digest ||
          request.authorization.stopProofDigest !== saved.stopAuthorization.stopProofDigest || !releaseReceipt ||
          (request.authorization as WorkerDispatch.ResumeAuthorization).runtimeReleaseDigest !== digestOf(releaseReceipt) ||
          digestOf(releaseReceipt.handle) !== digestOf(request.record.handle) || releaseReceipt.status !== "released") throw new Error("matrix_resume_binding_mismatch")
    }
    return { schemaVersion: "verified-worker-stop/1", requestDigest: digestOf(request), handle: request.record.handle,
      stopProofDigest: request.authorization.stopProofDigest, scopeId: pair.scopeId, generation: pair.generation,
      ...(request.mode === "resume" ? { runtimeReleaseDigest: digestOf(releaseReceipt) } : {}) }
  }
  const layer = WorkerDispatch.layerFromPath(join(spec.controlDirectory, "delivery.sqlite"), { adapter, verifyStopped, launch: () => ({
    workingDirectory: spec.workspace, runtime: { name: "opencode", version: spec.executable.version, sourceDigest: spec.executable.digest },
    model: { provider: "openai", model: "unbilled-fixture" }, wallMinutes: 10, restrictedBinding: restrictedConfigBinding(restricted), executionBudget: budget }) })
  await Effect.runPromise(Effect.gen(function* () {
    const worker = yield* WorkerDispatch.Service, delivery = yield* Delivery.Service
    const command = (type: string, fields: Record<string, unknown>) => delivery.execute({ schemaVersion: "command/1", type,
      commandId: randomUUID(), actor: { kind: "system", id: "m0-control-matrix" }, issuedAt: new Date().toISOString(), taskId: goal.taskId, ...fields }).pipe(
      Effect.flatMap((result) => result.kind === "receipt" && result.receipt.status === "accepted" ? Effect.succeed(result.receipt) : Effect.fail(new Error("matrix_command_rejected"))))
    if (phase === "execute") {
      const current = active()
      if (current.scopeId !== scopeId || current.generation !== generation || current.phase !== "running") throw new Error("matrix_execute_scope_invalid")
      const receiptBaseline = readdirSync(spec.workspace).filter((name) => /^receipt-\d+\.json$/.test(name)).sort()
      const dispatchNotBefore = Date.now()
      const existing = yield* delivery.getTask(goal.taskId)
      const mode = existing ? "cancel" : "pause"
      let coldPaused = false, missingProofRefused = false
      if (!existing) {
        yield* command("createTask", { expectedVersion: 0, goal }); yield* command("startRun", { expectedVersion: 1, runId: spec.runId }); yield* worker.drain()
      } else {
        const prior = (yield* worker.get(spec.runId))!, saved = read(pausePath)
        if (existing.runs[spec.runId]?.status !== "paused" || digestOf(prior.input?.executionBudget) !== digestOf(budget)) throw new Error("matrix_cold_pause_missing")
        coldPaused = true
        const resume = yield* command("resumeRun", { expectedVersion: existing.version, runId: spec.runId })
        const beforePreparation = prepareCalls
        const beforeReceipts = digestOf(readdirSync(spec.workspace).filter((name) => /^receipt-\d+\.json$/.test(name)).sort())
        denyHostProof = true
        const negative = yield* worker.resumeStopped(spec.runId, { nonce: "missing-stop-proof", previousOperationId: prior.handle.operationId,
          resumeCommandId: resume.commandId, stopProofDigest: saved.stopAuthorization.stopProofDigest, runtimeReleaseDigest: digestOf("not-yet-released") }).pipe(Effect.exit)
        denyHostProof = false
        missingProofRefused = Exit.isFailure(negative)
        if (!missingProofRefused || rejectedHostProofs !== 1 || prepareCalls !== beforePreparation ||
            (yield* worker.get(spec.runId))!.handle.operationId !== prior.handle.operationId ||
            digestOf(readdirSync(spec.workspace).filter((name) => /^receipt-\d+\.json$/.test(name)).sort()) !== beforeReceipts) throw new Error("matrix_missing_proof_admitted")
        controlMatrixResumeAuthority(active(), scopeId, generation, saved)
        if (digestOf(saved.record.handle) !== digestOf(prior.handle)) throw new Error("matrix_saved_attempt_changed")
        releaseReceipt = adapter.releaseStoppedReservation(prior.handle, { schemaVersion: "runtime-stopped-authorization/1", nonce: scopeId,
          stopProofDigest: saved.stopAuthorization.stopProofDigest, workingDirectory: spec.workspace,
          requestDigest: digestOf({ input: prior.input, operationId: prior.handle.operationId }) })
        save(join(reports, `runtime-release-${scopeId}.json`), releaseReceipt)
        const result = yield* worker.resumeStopped(spec.runId, { nonce: scopeId, previousOperationId: prior.handle.operationId,
          resumeCommandId: resume.commandId, stopProofDigest: saved.stopAuthorization.stopProofDigest, runtimeReleaseDigest: digestOf(releaseReceipt) })
        if (result.record?.phase !== "started" || result.record.handle.attemptId === prior.handle.attemptId) throw new Error("matrix_new_attempt_missing")
      }
      const record = (yield* worker.get(spec.runId))!
      if (record.phase !== "started") throw new Error("matrix_runtime_not_started")
      const childReceipt = yield* Effect.promise(async () => {
        const deadline = Date.now() + 5000
        let observed = adapter.inspect(record.handle)
        while (!observed.pid || !existsSync(join(spec.workspace, `receipt-${observed.pid}.json`))) {
          if (["exited", "spawn_failed"].includes(observed.status)) {
            save(join(reports, `child-ended-${scopeId}.json`), { scopeId, generation, observed, usesActualOpenCodeExecutable: false, modelCalls: 0 })
            throw new Error("matrix_child_ended_before_receipt")
          }
          if (Date.now() >= deadline) throw new Error("matrix_child_receipt_timeout")
          await Bun.sleep(20); observed = adapter.inspect(record.handle)
        }
        return readFreshFixtureReceipt({ directory: spec.workspace, record, existingNames: receiptBaseline, notBefore: dispatchNotBefore,
          inspect: () => adapter.inspect(record.handle) })
      })
      yield* worker.inspect(spec.runId)
      if ((yield* delivery.getRun(spec.runId))?.status !== "running") throw new Error("matrix_running_fact_missing")
      const receipt = yield* command(mode === "pause" ? "pauseRun" : "cancelRun", { expectedVersion: (yield* delivery.getTask(goal.taskId))!.version, runId: spec.runId })
      yield* worker.drain()
      const stopped = (yield* worker.get(spec.runId))!
      if ((yield* delivery.getRun(spec.runId))?.status !== (mode === "pause" ? "pausing" : "cancelling") || adapter.inspect(stopped.handle).status !== "exited")
        throw new Error("matrix_control_skipped_stop_proof")
      save(executePath, { schemaVersion: "m0-control-matrix-execution/1", mode, scopeId, generation, taskId: goal.taskId, runId: spec.runId,
        operationId: stopped.handle.operationId, controlEventId: receipt.eventId, record: stopped, childReceipt, budget, coldPaused, missingProofRefused,
        missingProofInjection: mode === "cancel" ? { layer: "trusted_host_verifyStopped", realCommittedResume: true, rejectedHostProofs,
          beforeRuntimeRelease: true, newAttempts: 0, preparations: 0, spawns: 0 } : null,
        priorRunPinsUnchanged: verifyPriorRunPins(), usesActualOpenCodeExecutable: false, modelCalls: 0, status: "awaiting_independent_supervisor_stop" })
    } else {
      const pair = controlMatrixProofs(active(), scopeId, generation), execution = read(executePath)
      const provided = args.get("--stop-proof")!
      protectedPath(provided)
      if (digestOf(read(provided)) !== digestOf(pair.worker)) throw new Error("matrix_stop_file_mismatch")
      const record = (yield* worker.get(spec.runId))!, authority = { pair, execution }
      const authorization = { nonce: `stop-${scopeId}`, previousOperationId: record.handle.operationId, stopProofDigest: digestOf(authority) }
      yield* worker.confirmStopped(spec.runId, authorization)
      const status = (yield* delivery.getRun(spec.runId))!.status
      if (status !== (execution.mode === "pause" ? "paused" : "cancelled")) throw new Error("matrix_final_state_invalid")
      save(join(reports, execution.mode === "pause" ? "pause-finalized.json" : "cancel-finalized.json"), {
        schemaVersion: "m0-control-matrix-final/1", mode: execution.mode, scopeId, generation, status,
        record: (yield* worker.get(spec.runId))!, authority, stopAuthorization: authorization, budget,
        history: yield* worker.controlHistory(spec.runId), priorRunPinsUnchanged: verifyPriorRunPins(), usesActualOpenCodeExecutable: false, modelCalls: 0, gate: "not_evaluated" })
    }
  }).pipe(Effect.provide(layer), Effect.scoped))
  // Reopen the real SQLite connection after the finalizer's transaction/scope
  // closes. This is a cold control-plane read, with no adapter dispatch call.
  if (phase === "finalize") {
    const run = await Effect.runPromise(Effect.gen(function* () { return yield* (yield* Delivery.Service).getRun(spec.runId) }).pipe(
      Effect.provide(Delivery.layerFromPath(join(spec.controlDirectory, "delivery.sqlite"))), Effect.scoped))
    if (!["paused", "cancelled"].includes(run?.status ?? "")) throw new Error("matrix_cold_terminal_state_missing")
    save(join(reports, `cold-read-${scopeId}.json`), { runId: spec.runId, status: run!.status, budget, priorRunPinsUnchanged: verifyPriorRunPins(), usesActualOpenCodeExecutable: false, modelCalls: 0 })
  }
  console.log(JSON.stringify({ status: "matrix_phase_complete", phase, scopeId, generation, modelCalls: 0 }))
}
if (process.argv[1] && (import.meta.url === pathToFileURL(process.argv[1]).href || process.argv[1].endsWith("/control-matrix.mjs")))
  main().catch((error) => { console.error(error instanceof Error ? error.message : "matrix_failed"); process.exitCode = 1 })
