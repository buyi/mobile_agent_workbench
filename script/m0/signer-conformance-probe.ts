/** Run only as a reviewed root controller beneath the finite Supervisor.
 * No model, key creation, configuration change, Task/Run mutation or repair.
 * Positive control must complete before any negative result can be accepted.
 */
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
import { digestOf, parse, validateGate, type GoalSpec } from "../../packages/contracts/src"
import { CONFIG_PATH, byteDigest, verifySignedCheck, type Binding, type VerifierConfig, type VerifyRequest } from "../../packages/verifier/src/service"
import type { ControlLoopSpec } from "./control-loop"

const FINAL = "/private/var/loopit/m0-runs/m0-code-loop-20261009a"
const GOOD = 'export function sumEvenThrough(n: number): number { if (!Number.isInteger(n) || n < 0 || n > 10000) throw new RangeError("n must be an integer from 0 through 10000"); let total = 0; for (let value = 0; value <= n; value += 2) total += value; return total; }\n'
export type ProcessObservation = { status: number | null; signal: string | null; error?: string; stdout: string; stderr: string }
export function decodeSignerProcess(child: ProcessObservation): any {
  if (child.error || child.signal || ![0, 2].includes(child.status ?? -1)) throw new Error("signer_process_incomplete")
  const response = JSON.parse(child.stdout)
  if (response.schemaVersion !== "verify-candidate-response/1" ||
      (child.status === 0 ? response.status !== "passed" : !["failed", "blocked"].includes(response.status)))
    throw new Error("signer_exit_response_mismatch")
  return response
}
export function assertBlocked(response: any, expected: string) {
  if (response.status !== "blocked" || response.error !== expected || response.signedCheck || response.evidence)
    throw new Error("expected_exact_unsigned_rejection")
}
export function assertObservedCases(report: any, request: VerifyRequest, config: VerifierConfig, expectPass: boolean) {
  if (report.schemaVersion !== "fixture-verification-evidence/1" || report.requestId !== request.requestId ||
      report.candidateDigest !== request.candidateDigest || digestOf(report.binding) !== digestOf(request.binding) ||
      report.testsDigest !== config.tests.digest || report.runtimeDigest !== config.runtime.digest || report.runnerDigest !== config.runner.digest ||
      report.executionError || report.status !== (expectPass ? "passed" : "failed") ||
      report.isolation?.network !== "none" || report.isolation?.signerUid !== 421 ||
      report.isolation?.candidateEvaluatedInSigner !== false || report.isolation?.childContainsKey !== false)
    throw new Error("evidence_identity_or_isolation_mismatch")
  if (!Array.isArray(report.observations) || report.observations.length !== 12 || report.observations.some((item: any, index: number) =>
    item.caseIndex !== index || item.process?.code !== 0 || item.process?.signal || item.process?.error || item.process?.timedOut || item.process?.overflow ||
    (item.matched ? item.reason !== undefined : item.reason !== "case_failed"))) throw new Error("cases_not_independently_observed")
  if (expectPass ? report.observations.some((item: any) => !item.matched) : !report.observations.some((item: any) => !item.matched))
    throw new Error("control_case_outcome_mismatch")
}
function protectedFile(path: string, owner = 0) {
  if (realpathSync(path) !== path) throw new Error("noncanonical_trusted_path")
  for (let current = path; ; current = dirname(current)) {
    const info = lstatSync(current)
    if (![0, owner].includes(info.uid) || info.mode & 0o022) throw new Error("unprotected_trusted_path")
    if (current === "/") break
  }
  const info = lstatSync(path)
  if (!info.isFile() || info.nlink !== 1) throw new Error("invalid_trusted_file")
  return readFileSync(path)
}
function pinned(file: { path: string; digest: string }, owner = 0) {
  const bytes = protectedFile(file.path, owner)
  if (byteDigest(bytes) !== file.digest) throw new Error("trusted_pin_changed")
  return bytes
}
function immutable(path: string, value: Buffer | string, mode = 0o444) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
  try { writeFileSync(fd, value); fsyncSync(fd) } finally { closeSync(fd) }
  const directory = openSync(dirname(path), constants.O_RDONLY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
}
function evidenceBytes(response: any, requestId: string, config: VerifierConfig) {
  const path = join(config.evidenceRoot, requestId, "evidence.json")
  if (response.evidence?.ref !== `${pathToFileURL(path)}#${response.evidence?.digest}`) throw new Error("evidence_path_not_bound")
  return pinned({ path, digest: response.evidence.digest }, 421)
}

async function main() {
  if (process.platform !== "darwin" || process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw new Error("root_controller_required")
  const args = new Map<string, string>()
  for (let index = 2; index < process.argv.length; index += 2) {
    if (!process.argv[index + 1] || args.has(process.argv[index])) throw new Error("invalid_arguments")
    args.set(process.argv[index], process.argv[index + 1])
  }
  const phase = args.get("--phase"), scopeId = args.get("--scope")!, generation = Number(args.get("--generation"))
  if (!/^[a-f0-9-]{36}$/.test(scopeId) || !Number.isSafeInteger(generation) || generation < 1 || !["execute", "finalize"].includes(phase!)) throw new Error("invalid_scope")
  const lock = Number(process.env.LOOPIT_SUPERVISOR_LOCK_FD)
  if (!Number.isSafeInteger(lock) || lock < 3 || fstatSync(lock).uid !== 0 || !fstatSync(lock).isFile()) throw new Error("supervisor_lock_required")
  if (args.get("--spec") !== join(FINAL, "control/spec.json")) throw new Error("fixed_spec_required")
  const spec = JSON.parse(protectedFile(args.get("--spec")!).toString()) as ControlLoopSpec
  if (spec.controlDirectory !== join(FINAL, "control") || spec.verifierConfigPath !== CONFIG_PATH) throw new Error("fixed_configuration_required")
  for (const file of [spec.bun, spec.wrapper, spec.verifierCli, spec.tests, spec.source, spec.goal]) pinned(file)
  const config = JSON.parse(pinned({ path: CONFIG_PATH, digest: spec.verifierConfigDigest }, 421).toString()) as VerifierConfig
  if (config.inboxRoot !== "/private/var/loopit/signer/m0-verifier/inbox" || config.evidenceRoot !== "/private/var/loopit/signer/m0-verifier/evidence") throw new Error("fixed_signer_roots_required")
  const trust = protectedFile(spec.verifierPublicKeyPath).toString()
  const goalResult = parse("goal", JSON.parse(pinned(spec.goal).toString()))
  if (!goalResult.ok) throw new Error("invalid_goal")
  const goal: GoalSpec = goalResult.value
  const binding: Binding = { projectId: goal.projectId, taskId: goal.taskId, goalRevision: goal.goalRevision, runId: spec.runId,
    goalDigest: digestOf(goal), sourceDigest: spec.source.digest, acceptanceDigest: digestOf(goal.acceptance), criterionIds: ["M0-CODE-01"] }
  if (digestOf(binding) !== digestOf(config.binding) || config.keyId !== spec.verifierKeyId) throw new Error("configuration_binding_mismatch")
  if (phase === "execute") { console.log(JSON.stringify({ status: "ready_for_stopped_worker_verification", scopeId, generation })); return }
  const proofPath = args.get("--stop-proof")
  if (proofPath !== `/private/var/loopit/supervisor/${scopeId}.stop.json`) throw new Error("fixed_stop_proof_required")
  const proof = JSON.parse(protectedFile(proofPath).toString())
  if (proof.scopeId !== scopeId || proof.generation !== generation || proof.workerUid !== 420 || proof.noLiveWorkerProcesses !== true || proof.userDomainAbsent !== true || proof.externalActionsVerified !== false)
    throw new Error("worker_stop_proof_invalid")
  const reports: any[] = [], inboxFiles: string[] = []
  let failure: string | undefined
  const reportPath = join(spec.controlDirectory, "reports", `signer-conformance-${scopeId}.json`)
  if (existsSync(reportPath)) throw new Error("existing_report_refused")
  const expected = (candidateDigest: string) => ({ binding, candidateDigest, keyId: spec.verifierKeyId, testsDigest: spec.tests.digest })
  const request = (text: string | undefined) => {
    const requestId = randomUUID(), candidateFile = `conformance-${requestId}.ts`
    if (text !== undefined) { const path = join(config.inboxRoot, candidateFile); immutable(path, text); inboxFiles.push(path) }
    return { schemaVersion: "verify-candidate-request/1", requestId, candidateFile, candidateDigest: byteDigest(text ?? GOOD), binding: structuredClone(binding) } as VerifyRequest
  }
  const invoke = (name: string, input: VerifyRequest | object) => {
    const child = spawnSync("/usr/bin/python3", [spec.wrapper.path, "--uid", "421", "--gid", "420", "--signer-verifier"], {
      cwd: "/private/var/loopit/signer", env: { PATH: "/usr/bin:/bin", HOME: "/private/var/loopit/signer", LANG: "en_US.UTF-8",
        LOOPIT_SCOPE_ID: scopeId, LOOPIT_GENERATION: String(generation) }, input: JSON.stringify(input),
      timeout: 30000, maxBuffer: 1_048_576, encoding: "utf8" })
    const processResult: ProcessObservation = { status: child.status, signal: child.signal, error: child.error?.name, stdout: child.stdout, stderr: child.stderr }
    const item: any = { name, request: input, process: processResult }; reports.push(item)
    item.response = decodeSignerProcess(processResult)
    return item
  }
  const controls = (name: "known-good" | "known-bad", text: string) => {
    const input = request(text), item = invoke(name, input), pass = name === "known-good"
    if (item.response.requestId !== input.requestId || item.response.status !== (pass ? "passed" : "failed")) throw new Error("control_response_mismatch")
    const bytes = evidenceBytes(item.response, input.requestId, config)
    item.evidence = JSON.parse(bytes.toString()); assertObservedCases(item.evidence, input, config, pass)
    if (pass) {
      if (!verifySignedCheck(item.response.signedCheck, trust, expected(input.candidateDigest))) throw new Error("control_signature_invalid")
      const gate = parse("gate", item.response.signedCheck.payload.gate)
      if (!gate.ok || validateGate(gate.value, goal).length) throw new Error("control_gate_invalid")
      if (byteDigest(bytes) !== item.response.signedCheck.payload.evidence.digest ||
          digestOf(item.response.evidence) !== digestOf(item.response.signedCheck.payload.evidence)) throw new Error("signed_evidence_not_bound")
      const attestationPath = join(config.evidenceRoot, input.requestId, "signed-check.json")
      if (gate.value.verifier.signatureRef !== pathToFileURL(attestationPath).href ||
          digestOf(JSON.parse(protectedFile(attestationPath, 421).toString())) !== digestOf(item.response.signedCheck))
        throw new Error("attestation_not_persisted")
      item.signatureVerified = true
    } else if (item.response.signedCheck || existsSync(join(config.evidenceRoot, input.requestId, "signed-check.json"))) throw new Error("bad_candidate_signed")
    item.passed = true
    return item
  }
  const blocked = (name: string, input: VerifyRequest | object, error: string) => {
    const item = invoke(name, input); assertBlocked(item.response, error)
    const id = (input as VerifyRequest).requestId
    if (existsSync(join(config.evidenceRoot, id))) throw new Error("rejected_request_created_evidence")
    item.passed = true
  }
  try {
    const good = controls("known-good", GOOD)
    controls("known-bad", pinned(spec.source).toString())
    blocked("missing-candidate", request(undefined), "verifier_unavailable")
    const tampered = request(GOOD); tampered.candidateDigest = byteDigest("different requested bytes")
    blocked("wrong-candidate-digest", tampered, "candidate_digest_mismatch")
    const wrongRun = request(GOOD); wrongRun.binding.runId += "-wrong"
    blocked("wrong-run-binding", wrongRun, "request_binding_mismatch")
    blocked("caller-public-key", { ...request(GOOD), publicKey: "caller-key-not-trusted" }, "invalid_fields")
    const replay = invoke("duplicate-request", good.request)
    assertBlocked(replay.response, "verifier_unavailable")
    if (byteDigest(evidenceBytes(good.response, good.request.requestId, config)) !== good.response.evidence.digest) throw new Error("duplicate_overwrote_evidence")
    replay.passed = true
    const tamperedSignature = structuredClone(good.response.signedCheck)
    tamperedSignature.payload.candidateDigest = byteDigest("changed-signed-payload")
    if (verifySignedCheck(tamperedSignature, trust, expected(good.request.candidateDigest))) throw new Error("tampered_signature_accepted")
    reports.push({ name: "signed-payload-tamper", passed: true, executedBy: "trusted-parent-signature-check" })
  } catch (error) { failure = error instanceof Error ? error.message : "conformance_failed" }
  finally { for (const path of inboxFiles) unlinkSync(path) }
  // Recheck protected configuration bytes; this does not read the private key.
  pinned({ path: CONFIG_PATH, digest: spec.verifierConfigDigest }, 421)
  const outcome = { schemaVersion: "signer-conformance/1", status: failure ? "failed" : "passed", scopeId, generation, binding,
    verifierConfigDigest: spec.verifierConfigDigest, reports, failure, modelCalls: 0,
    scope: "Signer fixture conformance only; no Task transition, M0 milestone or M1 acceptance" }
  immutable(reportPath, JSON.stringify(outcome, null, 2) + "\n", 0o600)
  console.log(JSON.stringify({ status: outcome.status, report: reportPath }))
  if (failure) process.exitCode = 2
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(JSON.stringify({ status: "blocked", reason: error instanceof Error ? error.message : "probe_unavailable" })); process.exitCode = 2 })
}
