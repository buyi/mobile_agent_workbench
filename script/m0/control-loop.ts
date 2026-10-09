/** Finite M0 integration controller. Only installed, root-owned inputs are used.
 * OpenCode owns model/tool iteration; this controller connects durable task facts
 * to an independently signed result. A tiny task pass is not a milestone pass.
 */
import { createHash, randomUUID } from "node:crypto"
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
import { checkFrozen, digestOf, parse, validateGate, type GoalSpec } from "../../packages/contracts/src"
import type { RecoveryArtifact } from "../../packages/delivery/src/integration/context-recovery"
import type { RestrictedConfig, ExecutionBudget } from "../../packages/runtime/src"
import { CONFIG_PATH, verifySignedCheck, type Binding, type VerifierConfig } from "../../packages/verifier/src/service"
import { requireSignedFixtureAcceptance, runReadonlyAcceptance } from "./control-loop-acceptance"

import { openCodeProjectMarker, preparationStopAuthority, repairRunAuthority } from "./control-loop-authority"
export { openCodeProjectMarker, preparationStopAuthority, repairRunAuthority } from "./control-loop-authority"

type Pinned = { path: string; digest: string }
export interface ControlLoopSpec {
  schemaVersion: "m0-control-loop/1"; jobId: string; runId: string
  goal: Pinned; source: Pinned; tests: Pinned
  executable: Pinned & { version: string }; bun: Pinned; catalog: Pinned; wrapper: Pinned
  workspace: string; runtimeDirectory: string; controlDirectory: string; authPath: string
  verifierCli: Pinned; verifierConfigPath: string; verifierConfigDigest: string; verifierPublicKeyPath: string; verifierKeyId: string
}
const sha = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"))
function immutable(path: string, bytes: Buffer | string) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  const parent = openSync(dirname(path), constants.O_RDONLY)
  try { fsyncSync(parent) } finally { closeSync(parent) }
}
const save = (path: string, value: unknown) => immutable(path, JSON.stringify(value, null, 2) + "\n")
function protectedPath(path: string) {
  if (realpathSync(path) !== path) throw new Error("noncanonical_trusted_input")
  for (let part = path; ; part = dirname(part)) {
    const st = lstatSync(part)
    if (st.uid !== 0 || (st.mode & 0o022)) throw new Error("unprotected_trusted_input")
    if (part === "/") break
  }
}
function pinned(value: Pinned) {
  protectedPath(value.path)
  if (sha(readFileSync(value.path)) !== value.digest) throw new Error("pinned_input_changed")
}
/** Called only while Supervisor has closed admission and stopped all Worker UID processes. */
function candidateBytes(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.uid !== 420 || st.nlink !== 1 || st.size < 1 || st.size > 65536) throw new Error("candidate_file_invalid")
    const bytes = Buffer.alloc(st.size)
    let count = 0
    while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, count); if (!n) throw new Error("candidate_short_read"); count += n }
    const after = fstatSync(fd)
    if (st.size !== after.size || st.mtimeMs !== after.mtimeMs) throw new Error("candidate_changed")
    return bytes
  } finally { closeSync(fd) }
}
function validateWorkspace(spec: ControlLoopSpec) {
  const manifestPath = join(spec.controlDirectory, "install-manifest.json"); protectedPath(manifestPath)
  const manifest = readJson(manifestPath)
  if (manifest.finalRoot !== dirname(spec.controlDirectory)) throw new Error("workspace_manifest_mismatch")
  const expected = new Map<string, string>(manifest.files.filter((item: any) => item.path.startsWith("workspace/")).map((item: any) => [item.path.slice(10), item.digest]))
  const expectedDirectories = new Set([...expected.keys()].flatMap((path) => path.split("/").slice(0, -1).map((_, index) => path.split("/").slice(0, index + 1).join("/"))))
  const observed: Array<{ path: string; digest: string }> = []
  const runtimeMetadata: Array<{ path: string; digest: string }> = []
  const visit = (directory: string, prefix = "") => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), rel = prefix + name, st = lstatSync(path)
      if (st.isSymbolicLink() || st.uid !== 420) throw new Error("unexpected_workspace_entry")
      if (st.isDirectory()) { if (!expectedDirectories.has(rel) || rel.split("/").length > 8) throw new Error("workspace_directory_out_of_scope"); visit(path, rel + "/"); continue }
      if (!st.isFile() || st.nlink !== 1 || st.size > 1_048_576 || observed.length > 128) throw new Error("unexpected_workspace_file")
      // OpenCode v1.18.35 writes its project ID here while resolving a Git
      // repository, even during CLI preparation. This isolated fixture has no
      // remote; the ID must exactly equal the protected baseline root commit.
      if (rel === ".git/opencode" && !expected.has(rel)) {
        runtimeMetadata.push({ path: rel, digest: openCodeProjectMarker(readFileSync(path), manifest.baselineCommit) })
        continue
      }
      if (!expected.has(rel)) throw new Error("unexpected_workspace_file")
      const digest = sha(readFileSync(path)); observed.push({ path: rel, digest })
      if (rel !== "sumEvenThrough.ts" && digest !== expected.get(rel)) throw new Error("out_of_scope_workspace_edit")
    }
  }
  visit(spec.workspace)
  if (observed.length !== expected.size) throw new Error("workspace_file_missing")
  return { status: "passed", onlyAllowedFileMayChange: "sumEvenThrough.ts", observed, fixedRuntimeMetadata: runtimeMetadata }
}

export async function main() {
  if (process.platform !== "darwin" || process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw new Error("root_controller_required")
  const args = new Map<string, string>()
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!process.argv[i + 1] || args.has(process.argv[i])) throw new Error("invalid_arguments")
    args.set(process.argv[i], process.argv[i + 1])
  }
  if (args.get("--phase") === "readonly-acceptance") {
    if (args.size !== 2 || !args.has("--plan")) throw new Error("invalid_readonly_arguments")
    console.log(JSON.stringify(runReadonlyAcceptance(args.get("--plan")!, realpathSync(fileURLToPath(import.meta.url)))))
    process.exitCode = 2 // Same fail-closed acceptance outcome; no state transition.
    return
  }
  // Read-only acceptance must return before loading the execution/database modules.
  const { Effect } = await import("effect")
  const { Delivery, WorkerDispatch } = await import("../../packages/delivery/src")
  const { createExperienceCandidate, recoverRunContext } = await import("../../packages/delivery/src/integration/context-recovery")
  const { OpenCodeCli, restrictedConfigBinding } = await import("../../packages/runtime/src")
  const phase = args.get("--phase"), scopeId = args.get("--scope")!, generation = Number(args.get("--generation"))
  if (!["execute", "finalize"].includes(phase!) || !/^[a-f0-9-]{36}$/.test(scopeId) || !Number.isSafeInteger(generation) || generation < 1) throw new Error("invalid_scope")
  const lock = Number(process.env.LOOPIT_SUPERVISOR_LOCK_FD)
  if (!Number.isSafeInteger(lock) || lock < 3 || fstatSync(lock).uid !== 0 || !fstatSync(lock).isFile()) throw new Error("supervisor_lock_missing")
  // Keep the inherited descriptor alive until this trusted process exits.
  const specPath = args.get("--spec")!; protectedPath(specPath)
  const spec = readJson(specPath) as ControlLoopSpec
  if (spec.schemaVersion !== "m0-control-loop/1") throw new Error("invalid_spec")
  if (spec.verifierConfigPath !== CONFIG_PATH || realpathSync(CONFIG_PATH) !== CONFIG_PATH ||
      sha(readFileSync(CONFIG_PATH)) !== spec.verifierConfigDigest) throw new Error("fixed_verifier_configuration_changed")
  for (const value of [spec.goal, spec.source, spec.tests, spec.executable, spec.bun, spec.catalog, spec.wrapper, spec.verifierCli]) pinned(value)
  protectedPath(spec.controlDirectory)
  const parsed = parse("goal", readJson(spec.goal.path))
  if (!parsed.ok || checkFrozen(parsed.value).length) throw new Error("goal_not_frozen")
  const goal: GoalSpec = parsed.value
  const binding: Binding = { projectId: goal.projectId, taskId: goal.taskId, goalRevision: goal.goalRevision, runId: spec.runId,
    goalDigest: digestOf(goal), sourceDigest: spec.source.digest, acceptanceDigest: digestOf(goal.acceptance), criterionIds: ["M0-CODE-01"] }
  const reports = join(spec.controlDirectory, "reports"); mkdirSync(reports, { recursive: true, mode: 0o700 })
  const budgetPath = join(spec.controlDirectory, "execution-budget.json")
  if (!existsSync(budgetPath)) {
    if (phase !== "execute") throw new Error("execution_budget_missing")
    save(budgetPath, { deadlineAt: new Date(Date.now() + 60 * 60_000).toISOString(), repairIndex: 0, maxRepairs: 3 })
  }
  const budget = readJson(budgetPath) as ExecutionBudget
  const restricted: RestrictedConfig = {
    readPaths: ["sumEvenThrough.ts"], editPaths: ["sumEvenThrough.ts"], agent: { name: "m0-editor", steps: 8 },
    model: { provider: "openai", model: "gpt-6.1-sol", variant: "medium" }, catalog: spec.catalog,
    oauthAccess: async () => { protectedPath(spec.authPath); return readJson(spec.authPath) },
    isolation: { identityRuntime: spec.bun, runtimeDirectory: spec.runtimeDirectory, childIdentity: { uid: 420, gid: 420 },
      launcher: { argvPrefix: ["/usr/bin/python3", spec.wrapper.path, "--uid", "420", "--gid", "420", "--"], wrapperPath: spec.wrapper.path, wrapperDigest: spec.wrapper.digest },
      admission: { scopeId, generation }, denyRead: [spec.controlDirectory, "/private/var/loopit/signer"], proxyPort: 7897 },
  }
  const adapter = new OpenCodeCli({ executable: spec.executable.path, executableDigest: spec.executable.digest, version: spec.executable.version,
    stateDirectory: join(spec.controlDirectory, "runtime-state"), logLimitBytes: 1_048_576, restricted })
  const layer = WorkerDispatch.layerFromPath(join(spec.controlDirectory, "delivery.sqlite"), { adapter, launch: () => ({
    workingDirectory: spec.workspace, runtime: { name: "opencode", version: spec.executable.version, sourceDigest: spec.executable.digest },
    model: { provider: "openai", model: "gpt-6.1-sol" }, wallMinutes: 60, restrictedBinding: restrictedConfigBinding(restricted), executionBudget: budget,
  }) })
  await Effect.runPromise(Effect.gen(function* () {
    const delivery = yield* Delivery.Service, worker = yield* WorkerDispatch.Service
    const command = (type: string, fields: Record<string, unknown>) => delivery.execute({ schemaVersion: "command/1", type,
      commandId: randomUUID(), actor: { kind: "system", id: "m0-supervisor" }, issuedAt: new Date().toISOString(), taskId: goal.taskId, ...fields }).pipe(
        Effect.flatMap((result) => result.kind === "receipt" && result.receipt.status === "accepted" ? Effect.succeed(result.receipt) : Effect.fail(new Error(`command_rejected:${JSON.stringify(result)}`))))
    if (phase === "execute") {
      const existingTask = yield* delivery.getTask(goal.taskId)
      const boundaries = [
        { name: "worker_cannot_read_controller_auth", flag: "-r", path: spec.authPath, expected: 1 },
        { name: "worker_cannot_write_controller_state", flag: "-w", path: spec.controlDirectory, expected: 1 },
        { name: "worker_cannot_read_signing_key", flag: "-r", path: readJson(spec.verifierConfigPath).privateKeyPath, expected: 1 },
        { name: "worker_cannot_write_protected_tests", flag: "-w", path: spec.tests.path, expected: 1 },
        { name: "worker_can_write_candidate", flag: "-w", path: join(spec.workspace, "sumEvenThrough.ts"), expected: 0 },
      ].map((item) => {
        // Broad Seatbelt here deliberately leaves file denial to OS account
        // permissions. The model run separately uses its restrictive profile.
        const result = spawnSync("/usr/bin/python3", [spec.wrapper.path, "--uid", "420", "--gid", "420", "--", "/usr/bin/sandbox-exec", "-p",
          "(version 1)(allow default)(deny network*)", "/bin/test", item.flag, item.path], {
          cwd: spec.workspace, env: { PATH: "/usr/bin:/bin", LOOPIT_SCOPE_ID: scopeId, LOOPIT_GENERATION: String(generation) }, timeout: 5000, encoding: "utf8" })
        return { ...item, status: result.status, signal: result.signal,
          error: result.error ? { name: result.error.name, code: (result.error as NodeJS.ErrnoException).code } : null,
          stderr: result.stderr.slice(-2048), passed: !result.error && !result.signal && result.status === item.expected }
      })
      save(join(reports, `account-boundaries-${scopeId}.json`), boundaries)
      if (boundaries.some((item) => !item.passed)) throw new Error("os_account_boundary_failed")
      if (!existingTask) {
        yield* command("createTask", { expectedVersion: 0, goal })
        yield* command("startRun", { expectedVersion: 1, runId: spec.runId })
        yield* worker.drain()
      } else {
        const previous = yield* worker.get(spec.runId)
        if (!previous) {
          const authorizationPath = join(spec.controlDirectory, "repair-authorization.json"); protectedPath(authorizationPath)
          const authorization = readJson(authorizationPath)
          if (!/^run-[a-f0-9-]{36}$/.test(authorization.priorRunId)) throw new Error("invalid_prior_run_id")
          const resultPath = join(spec.controlDirectory, "run-history", authorization.priorRunId, "reports", "result.json"); protectedPath(resultPath)
          if (sha(readFileSync(resultPath)) !== authorization.priorResultDigest) throw new Error("prior_result_digest_mismatch")
          repairRunAuthority(authorization, readJson(resultPath), existingTask, spec.runId, budget)
          const activePath = "/private/var/loopit/supervisor/active.json"; protectedPath(activePath)
          const authority = preparationStopAuthority(readJson(activePath), scopeId, generation)
          validateWorkspace(spec)
          const releasedReservations: unknown[] = []
          for (const priorRunId of existingTask.revisions[goal.goalRevision].runIds) {
            const priorDispatch = yield* worker.get(priorRunId)
            if (priorDispatch?.phase !== "started" || !priorDispatch.input) continue
            if (existingTask.runs[priorRunId]?.status !== "failed" || priorDispatch.input.spec.workingDirectory !== spec.workspace)
              throw new Error("prior_runtime_release_not_authorized")
            const releaseAuthorization = {
              schemaVersion: "runtime-stopped-authorization/1", nonce: `${scopeId}-${priorRunId}`,
              stopProofDigest: digestOf(authority), workingDirectory: spec.workspace,
              requestDigest: digestOf({ input: priorDispatch.input, operationId: priorDispatch.handle.operationId }),
            } as const
            // A later repair reuses the original immutable release receipt. A
            // new scope must not replace that historical authorization or erase
            // a newer reservation occupying the same workspace.
            const archiveRoot = join(spec.controlDirectory, "runtime-state", "reconciliations")
            const previousReleases: any[] = []
            if (existsSync(archiveRoot)) for (const name of readdirSync(archiveRoot)) {
              const path = join(archiveRoot, name, "authorization.json"); protectedPath(path)
              const value = readJson(path)
              if (digestOf(value.handle) !== digestOf(priorDispatch.handle)) continue
              if (value.authorization.requestDigest !== releaseAuthorization.requestDigest || value.authorization.workingDirectory !== spec.workspace)
                throw new Error("prior_release_binding_changed")
              previousReleases.push(value.authorization)
            }
            if (previousReleases.length > 1) throw new Error("ambiguous_prior_release")
            releasedReservations.push(adapter.releaseStoppedReservation(priorDispatch.handle, previousReleases[0] ?? releaseAuthorization))
          }
          save(join(reports, "repair-admission.json"), { authorization, authority, releasedReservations, priorTaskVersion: existingTask.version })
          yield* command("startRun", { expectedVersion: existingTask.version, runId: spec.runId })
          yield* worker.drain()
        } else {
        if (!previous || previous.phase !== "quarantined" || previous.reason !== "runtime preparation failed; no new process dispatched" ||
            (yield* delivery.getRun(spec.runId))?.status !== "queued") throw new Error("task_already_admitted_no_blind_restart")
        const activePath = "/private/var/loopit/supervisor/active.json"; protectedPath(activePath)
        const authority = preparationStopAuthority(readJson(activePath), scopeId, generation)
        validateWorkspace(spec)
        if (sha(candidateBytes(join(spec.workspace, "sumEvenThrough.ts"))) !== spec.source.digest) throw new Error("preparation_recovery_candidate_changed")
        const authorization = { nonce: scopeId, previousOperationId: previous.handle.operationId, stopProofDigest: digestOf(authority) }
        save(join(reports, `recovery-authorization-${scopeId}.json`), { authorization, authority, previousDispatchDigest: digestOf(previous), budget })
        yield* worker.recoverPreparation(spec.runId, authorization)
        }
      }
      const record = yield* worker.get(spec.runId)
      if (!record || record.phase !== "started") throw new Error(`runtime_not_started:${record?.reason ?? "missing"}`)
      while (true) {
        const observed = adapter.inspect(record.handle)
        if (observed.status === "exited" || observed.status === "spawn_failed") break
        if (Date.now() > Date.parse(budget.deadlineAt)) { yield* Effect.promise(() => adapter.cancel(record.handle, "deadline")); break }
        yield* Effect.promise(() => Bun.sleep(200))
      }
      // Process exit precedes pipe close. Give the adapter's bounded redaction
      // grace time to finish before taking the immutable execution receipt.
      const captureDeadline = Date.now() + 500
      while (Date.now() < captureDeadline) {
        const logs = adapter.inspect(record.handle).logs
        if (!logs.redactionPending && (logs.pipesComplete || logs.stdoutTruncated || logs.stderrTruncated)) break
        yield* Effect.promise(() => Bun.sleep(10))
      }
      yield* worker.inspect(spec.runId)
      const collected = adapter.collect(record.handle)
      save(join(reports, "execution.json"), { scopeId, generation, binding, collected, run: yield* delivery.getRun(spec.runId), dispatch: yield* worker.get(spec.runId) })
      console.log(JSON.stringify({ phase, status: "awaiting_independent_verification", runId: spec.runId, exitCode: collected.observed.exitCode }))
      return
    }
    const proofPath = args.get("--stop-proof")!; protectedPath(proofPath)
    const proof = readJson(proofPath)
    if (proof.scopeId !== scopeId || proof.generation !== generation || proof.workerUid !== 420 || proof.noLiveWorkerProcesses !== true || proof.userDomainAbsent !== true || proof.externalActionsVerified !== false)
      throw new Error("worker_stop_proof_invalid")
    const prior = readJson(join(reports, "execution.json"))
    if (prior.scopeId !== scopeId || prior.generation !== generation || digestOf(prior.binding) !== digestOf(binding)) throw new Error("execution_scope_mismatch")
    const record = yield* worker.get(spec.runId)
    if (!record?.input || record.phase !== "started") throw new Error("dispatch_missing")
    const run = yield* delivery.getRun(spec.runId)
    if (run?.status !== "waiting") throw new Error("run_not_awaiting_verification")
    yield* command("reportRun", { runId: spec.runId, to: "running", reason: "Supervisor stopped all Worker processes; trusted verification begins" })
    yield* command("reportRun", { runId: spec.runId, to: "verifying", reason: "Independent signer will evaluate immutable candidate bytes" })
    save(join(reports, "workspace-boundary.json"), validateWorkspace(spec))
    const bytes = candidateBytes(join(spec.workspace, "sumEvenThrough.ts")), candidateDigest = sha(bytes)
    immutable(join(reports, "candidate.ts"), bytes)
    const verifierConfig = readJson(spec.verifierConfigPath) as VerifierConfig
    if (digestOf(verifierConfig.binding) !== digestOf(binding) || verifierConfig.keyId !== spec.verifierKeyId) throw new Error("verifier_config_binding_mismatch")
    const verify = (input: Buffer) => {
      const requestId = randomUUID(), candidateFile = `${requestId}.ts`, inboxPath = join(verifierConfig.inboxRoot, candidateFile)
      // root-owned immutable file in signer-only inbox; Worker has no access.
      const fd = openSync(inboxPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o444)
      try { writeFileSync(fd, input); fsyncSync(fd) } finally { closeSync(fd) }
      // Trusted Signer parent must be able to apply Seatbelt to each candidate
      // child. macOS rejects nested sandbox_apply; the finite launcher pins the
      // exact Signer executable instead of accepting arbitrary unsandboxed code.
      const child = spawnSync("/usr/bin/python3", [spec.wrapper.path, "--uid", "421", "--gid", "420", "--signer-verifier"], {
        cwd: "/private/var/loopit/signer", env: { PATH: "/usr/bin:/bin", HOME: "/private/var/loopit/signer", LANG: "en_US.UTF-8",
          LOOPIT_SCOPE_ID: scopeId, LOOPIT_GENERATION: String(generation) }, timeout: 30_000, maxBuffer: 1_048_576, encoding: "utf8",
        input: JSON.stringify({ schemaVersion: "verify-candidate-request/1", requestId, candidateFile, candidateDigest: sha(input), binding }),
      })
      let response: any
      try { response = JSON.parse(child.stdout) } catch { response = { status: "blocked", error: "invalid_signer_output" } }
      return { child, response, requestId }
    }
    const bad = verify(readFileSync(spec.source.path))
    const knownGoodBytes = Buffer.from('export function sumEvenThrough(n: number): number { if (!Number.isInteger(n) || n < 0 || n > 10000) throw new RangeError("n must be an integer from 0 through 10000"); let total = 0; for (let value = 0; value <= n; value += 2) total += value; return total; }\n')
    const good = verify(knownGoodBytes)
    const controlsPassed = bad.child.status === 2 && !bad.child.error && bad.response.status === "failed" && !bad.response.signedCheck &&
      good.child.status === 0 && !good.child.error && good.response.status === "passed" && verifySignedCheck(good.response.signedCheck,
        readFileSync(spec.verifierPublicKeyPath, "utf8"), { binding, candidateDigest: sha(knownGoodBytes), keyId: spec.verifierKeyId, testsDigest: spec.tests.digest })
    save(join(reports, "verifier-controls.json"), { passed: controlsPassed,
      bad: { processStatus: bad.child.status, response: bad.response }, good: { processStatus: good.child.status, response: good.response } })
    const { child, response, requestId } = verify(bytes)
    save(join(reports, "verification-response.json"), { process: { status: child.status, signal: child.signal, error: child.error?.message }, response })
    let accepted = controlsPassed && prior.collected.observed.exitCode === 0 && !prior.collected.observed.signal &&
      prior.collected.observed.evidence.available && prior.collected.observed.logs.pipesComplete &&
      !prior.collected.observed.logs.stdoutTruncated && !prior.collected.observed.logs.stderrTruncated &&
      !child.error && child.status === 0 && !child.signal && response.requestId === requestId && response.status === "passed"
    protectedPath(spec.verifierPublicKeyPath)
    accepted = accepted && verifySignedCheck(response.signedCheck, readFileSync(spec.verifierPublicKeyPath, "utf8"), {
      binding, candidateDigest, keyId: spec.verifierKeyId, testsDigest: spec.tests.digest })
    if (accepted) {
      const evidence = response.signedCheck.payload.evidence
      const evidenceUrl = new URL(evidence.ref), evidencePath = fileURLToPath(evidenceUrl)
      if (!evidencePath.startsWith(verifierConfig.evidenceRoot + "/") || realpathSync(evidencePath) !== evidencePath) throw new Error("evidence_path_invalid")
      const evidenceBytes = readFileSync(evidencePath)
      if (sha(evidenceBytes) !== evidence.digest || response.evidence.digest !== evidence.digest) throw new Error("evidence_digest_invalid")
      requireSignedFixtureAcceptance(response.signedCheck, evidenceBytes, readFileSync(spec.verifierPublicKeyPath, "utf8"), {
        binding, candidateDigest, keyId: spec.verifierKeyId, testsDigest: spec.tests.digest,
      }, { notBefore: record.createdAt, deadlineAt: budget.deadlineAt })
      immutable(join(reports, "verification-evidence.json"), evidenceBytes)
      const gate = parse("gate", response.signedCheck.payload.gate)
      if (!gate.ok || validateGate(gate.value, goal).length || gate.value.inputEvidenceDigests[0] !== evidence.digest) throw new Error("signed_gate_invalid")
      save(join(reports, "gate.json"), gate.value)
      save(join(reports, "signed-check.json"), response.signedCheck)
    }
    const artifacts: RecoveryArtifact[] = []
    const index = (name: string, role: RecoveryArtifact["role"]) => {
      const path = join(reports, name), digest = sha(readFileSync(path)), observedAt = new Date().toISOString()
      const value = { ref: `artifact://m0/${spec.jobId}/${name}#${digest}`, path: name, digest, role, taskId: goal.taskId,
        goalRevision: goal.goalRevision, runId: spec.runId, attemptId: record.handle.attemptId, observedAt, expiresAt: new Date(Date.now() + 86400_000).toISOString() }
      artifacts.push(value); return value.ref
    }
    const candidateRef = index("candidate.ts", "candidate"), evidenceRefs = [index(accepted ? "verification-evidence.json" : "verification-response.json", "evidence")]
    const log = prior.collected.artifacts.find((value: any) => value.path.endsWith("/stdout.log"))
    if (!log?.available || sha(readFileSync(log.path)) !== log.digest) throw new Error("runtime_log_unavailable")
    immutable(join(reports, "native.jsonl"), readFileSync(log.path))
    const nativeRef = index("native.jsonl", "log")
    const preparationHistory = yield* worker.preparationHistory(spec.runId)
    save(join(reports, "preparation-history.json"), preparationHistory)
    const preparationRef = index("preparation-history.json", "log")
    const recovered = yield* recoverRunContext({ delivery, dispatch: worker }, { runId: spec.runId, artifactRoot: reports, artifacts,
      candidateRef, evidenceRefs, nativeUsageRefs: [nativeRef], logRefs: [nativeRef, preparationRef] })
    save(join(reports, "recovered-context.json"), recovered)
    if (recovered.status !== "ready" || recovered.snapshot.usage.status !== "observed") accepted = false
    if (recovered.status === "ready") save(join(reports, "experience-candidate.json"), createExperienceCandidate(recovered.snapshot, {
      id: `experience-${spec.jobId}`, version: 1, summary: accepted ? "A bounded OpenCode edit passed the independently pinned 12-case verifier after Worker stop; source evidence is retained." : "Execution completed but independent acceptance remains unresolved; never reuse this result as a passing policy.",
      expiresAt: new Date(Date.now() + 86400_000).toISOString() }))
    save(join(reports, "artifact-index.json"), artifacts)
    const gateRef = pathToFileURL(join(reports, "gate.json")).href
    const currentTask = yield* delivery.getTask(goal.taskId)
    const alreadyReportedWallMs = currentTask!.revisions[goal.goalRevision].usage.wallMs
    const totalElapsedMs = Math.max(0, Date.now() - (Date.parse(budget.deadlineAt) - 60 * 60_000))
    yield* command("reportRun", { runId: spec.runId, to: accepted ? "succeeded" : "failed", reason: accepted ? "Trusted signer signature, exact evidence bytes, goal Gate and recovered context verified" : "Independent verification failed or remained blocked",
      ...(accepted ? { gateRef } : { closeRevision: false }), usage: { cost: { known: false, reason: "OAuth subscription billing is not independently measurable" },
        wallMs: Math.max(0, totalElapsedMs - alreadyReportedWallMs), humanInterventions: 0,
        ...(recovered.status === "ready" ? { modelCalls: recovered.snapshot.usage.modelSteps } : {}) } })
    const task = yield* delivery.getTask(goal.taskId), replay = yield* delivery.replay(goal.taskId)
    if (digestOf(task) !== digestOf(replay)) throw new Error("event_replay_mismatch")
    save(join(reports, "result.json"), { schemaVersion: "m0-control-loop-result/1", status: accepted ? "passed" : "failed", scopeId, generation, binding,
      candidateDigest, task, run: yield* delivery.getRun(spec.runId), usage: recovered.status === "ready" ? recovered.snapshot.usage : null,
      preparationRecoveryCount: preparationHistory.length, preparationHistoryRef: preparationRef,
      processStopProof: proof, eventReplayMatches: true, milestonePassed: false, m1FeatureImplemented: false })
    console.log(JSON.stringify({ phase, status: accepted ? "passed" : "failed", report: join(reports, "result.json"), milestonePassed: false }))
    if (!accepted) process.exitCode = 2
  }).pipe(Effect.provide(layer), Effect.scoped))
}

if (import.meta.main) main().catch((error) => { console.error(String(error)); process.exitCode = 2 })
