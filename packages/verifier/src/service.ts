import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto"
import { canonicalJson, digestOf } from "../../contracts/src/digest"
import { parse } from "../../contracts/src/registry"
import { validateGate } from "../../contracts/src/gate"
import { compilePureFixture } from "./pure-source"
import { executeCase, fixtureSandbox, type CaseExecution, type ChildResult } from "./sandbox"

export const CONFIG_PATH = "/private/var/loopit/signer/m0-verifier/config.json"
export const SIGNER_UID = 421
const digestPattern = /^sha256:[0-9a-f]{64}$/
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export const byteDigest = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
type PinnedFile = { path: string; digest: string }
export type Binding = { projectId: string; taskId: string; goalRevision: number; runId: string;
  goalDigest: string; sourceDigest: string; acceptanceDigest: string; criterionIds: string[] }
export type VerifierConfig = {
  schemaVersion: "m0-verifier-config/1"; verifierId: string; signerUid: number; builderUid: number;
  inboxRoot: string; workRoot: string; evidenceRoot: string;
  runtime: PinnedFile; runner: PinnedFile; tests: PinnedFile; source: PinnedFile; goal: PinnedFile;
  privateKeyPath: string; keyId: string; binding: Binding;
}
export type VerifyRequest = { schemaVersion: "verify-candidate-request/1"; requestId: string;
  candidateFile: string; candidateDigest: string; binding: Binding }
type FixtureCase = { id: string; input: number | "NaN"; expected: { kind: "returned"; value: number } | { kind: "threw"; name: "RangeError" } }

function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error("invalid_fields")
}
function validBinding(value: unknown): asserts value is Binding {
  exact(value, ["projectId", "taskId", "goalRevision", "runId", "goalDigest", "sourceDigest", "acceptanceDigest", "criterionIds"])
  for (const key of ["projectId", "taskId", "runId"]) if (typeof value[key] !== "string" || !idPattern.test(value[key] as string)) throw new Error("invalid_binding")
  for (const key of ["goalDigest", "sourceDigest", "acceptanceDigest"]) if (typeof value[key] !== "string" || !digestPattern.test(value[key] as string)) throw new Error("invalid_binding")
  if (!Number.isSafeInteger(value.goalRevision) || Number(value.goalRevision) < 1 || !Array.isArray(value.criterionIds) ||
      value.criterionIds.length < 1 || new Set(value.criterionIds).size !== value.criterionIds.length ||
      value.criterionIds.some((id) => typeof id !== "string" || !idPattern.test(id))) throw new Error("invalid_binding")
}
export function parseRequest(value: unknown): VerifyRequest {
  exact(value, ["schemaVersion", "requestId", "candidateFile", "candidateDigest", "binding"])
  if (value.schemaVersion !== "verify-candidate-request/1" || typeof value.requestId !== "string" || !idPattern.test(value.requestId) ||
      typeof value.candidateFile !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.ts$/.test(value.candidateFile) ||
      typeof value.candidateDigest !== "string" || !digestPattern.test(value.candidateDigest)) throw new Error("invalid_request")
  validBinding(value.binding)
  return value as VerifyRequest
}

// These checks complement, rather than certify, the separately tested OS/ACL
// deployment. CLI code, runtime, runner and tests must be root-installed.
function securePath(path: string, uid: number, writable = false) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("noncanonical_path")
  let current = path
  while (true) {
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || ![0, uid].includes(stat.uid)) throw new Error("untrusted_path_owner")
    const stickySystemDirectory = stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1000) !== 0
    if ((stat.mode & 0o022) && !stickySystemDirectory) throw new Error("writable_protected_path")
    if (current === path && writable && (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077))) throw new Error("private_directory_required")
    if (current === dirname(current)) break
    current = dirname(current)
  }
}
function protectedBytes(path: string, uid: number, limit = 1024 * 1024): Buffer {
  securePath(path, uid)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error("invalid_protected_file")
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    if (bytes.length !== before.size || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size)
      throw new Error("protected_file_changed")
    return bytes
  } finally { closeSync(fd) }
}
function pinnedBytes(file: PinnedFile, uid: number, limit?: number) {
  exact(file, ["path", "digest"])
  if (typeof file.path !== "string" || !digestPattern.test(file.digest)) throw new Error("invalid_pinned_file")
  const bytes = protectedBytes(file.path, uid, limit)
  if (byteDigest(bytes) !== file.digest) throw new Error("protected_digest_mismatch")
  return bytes
}
function fixtureCases(bytes: Buffer): FixtureCase[] {
  const value = JSON.parse(bytes.toString("utf8"))
  exact(value, ["schemaVersion", "cases"])
  if (value.schemaVersion !== "sum-even-cases/1" || !Array.isArray(value.cases) || value.cases.length !== 12) throw new Error("invalid_cases")
  const inputs = [0, 1, 2, 3, 4, 10, 11, 10000, -1, 1.5, "NaN", 10001]
  const expected = [0, 0, 2, 2, 6, 30, 30, 25005000]
  const ids = new Set<string>()
  for (let i = 0; i < 12; i++) {
    const item = value.cases[i]
    exact(item, ["id", "input", "expected"])
    const want = i < 8 ? { kind: "returned", value: expected[i] } : { kind: "threw", name: "RangeError" }
    if (typeof item.id !== "string" || !idPattern.test(item.id) || ids.has(item.id) || item.input !== inputs[i] || canonicalJson(item.expected) !== canonicalJson(want))
      throw new Error("fixed_fixture_changed")
    ids.add(item.id)
  }
  return value.cases as FixtureCase[]
}

/** Library seam is for non-privileged conformance tests. The production CLI never
 * accepts a config path, trusted UID or executor from its caller/environment. */
export function loadConfiguration(path: string, uid: number) {
  const raw = protectedBytes(path, uid)
  const config: VerifierConfig = JSON.parse(raw.toString("utf8"))
  exact(config, ["schemaVersion", "verifierId", "signerUid", "builderUid", "inboxRoot", "workRoot", "evidenceRoot",
    "runtime", "runner", "tests", "source", "goal", "privateKeyPath", "keyId", "binding"])
  if (config.schemaVersion !== "m0-verifier-config/1" || config.verifierId !== "loopit-signer" || config.signerUid !== uid ||
      !Number.isSafeInteger(config.builderUid) || config.builderUid < 1 || !digestPattern.test(config.keyId)) throw new Error("invalid_configuration")
  validBinding(config.binding)
  securePath(config.workRoot, uid, true); securePath(config.evidenceRoot, uid, true)
  // The inbox itself is root/signer-owned. It may grant builder file creation by
  // a separately checked ACL; builder must not be able to replace this directory.
  securePath(config.inboxRoot, uid)
  if (!lstatSync(config.inboxRoot).isDirectory()) throw new Error("invalid_inbox")
  const paths = [config.inboxRoot, config.workRoot, config.evidenceRoot]
  if (new Set(paths).size !== 3 || paths.some((a) => paths.some((b) => a !== b && a.startsWith(b + "/")))) throw new Error("overlapping_roots")
  const tests = fixtureCases(pinnedBytes(config.tests, uid))
  pinnedBytes(config.runner, uid); pinnedBytes(config.runtime, uid, 512 * 1024 * 1024)
  if (config.source.digest !== config.binding.sourceDigest) throw new Error("source_binding_mismatch")
  pinnedBytes(config.source, uid, 64 * 1024)
  const goal = JSON.parse(pinnedBytes(config.goal, uid).toString("utf8"))
  const parsedGoal = parse("goal", goal)
  if (!parsedGoal.ok || parsedGoal.value.targetMatrix.length !== 0 || parsedGoal.value.acceptance.length !== 1 ||
      parsedGoal.value.acceptance[0].id !== "M0-CODE-01" || canonicalJson(config.binding.criterionIds) !== '["M0-CODE-01"]')
    throw new Error("unsupported_goal_scope")
  if (digestOf(goal) !== config.binding.goalDigest || digestOf(goal.acceptance) !== config.binding.acceptanceDigest ||
      goal.projectId !== config.binding.projectId || goal.taskId !== config.binding.taskId || goal.goalRevision !== config.binding.goalRevision ||
      !Array.isArray(goal.acceptance) || config.binding.criterionIds.some((id) => !goal.acceptance.some((item: { id?: string }) => item.id === id)))
    throw new Error("goal_binding_mismatch")
  const keyBytes = protectedBytes(config.privateKeyPath, uid, 16 * 1024)
  if (lstatSync(config.privateKeyPath).mode & 0o077) throw new Error("private_key_permissions")
  const key = createPrivateKey(keyBytes)
  const publicKey = createPublicKey(key)
  if (key.asymmetricKeyType !== "ed25519" || byteDigest(publicKey.export({ format: "der", type: "spki" })) !== config.keyId)
    throw new Error("signing_key_mismatch")
  return { config, tests, key, publicKey, goal: parsedGoal.value, configDigest: byteDigest(raw) }
}

function candidateBytes(config: VerifierConfig, request: VerifyRequest) {
  const path = join(config.inboxRoot, request.candidateFile)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024 || ![0, config.builderUid].includes(before.uid)) throw new Error("invalid_candidate_file")
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    if (bytes.length !== before.size || before.mtimeMs !== after.mtimeMs || before.size !== after.size || byteDigest(bytes) !== request.candidateDigest)
      throw new Error("candidate_digest_mismatch")
    return bytes
  } finally { closeSync(fd) }
}
function syncDirectory(path: string) {
  const directory = openSync(path, constants.O_RDONLY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
}
function persist(path: string, bytes: Buffer) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o400)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  try { linkSync(temporary, path); unlinkSync(temporary) } catch (error) { try { unlinkSync(temporary) } catch {}; throw error }
  syncDirectory(dirname(path))
  if (!readFileSync(path).equals(bytes)) throw new Error("evidence_persistence_mismatch")
}

export async function verifyCandidate(loaded: ReturnType<typeof loadConfiguration>, input: unknown,
  executor: (input: CaseExecution) => Promise<ChildResult> = executeCase) {
  const request = parseRequest(input), { config } = loaded
  if (canonicalJson(request.binding) !== canonicalJson(config.binding)) throw new Error("request_binding_mismatch")
  const bytes = candidateBytes(config, request)
  const compiled = Buffer.from(compilePureFixture(bytes.toString("utf8")))
  const compiledDigest = byteDigest(compiled)
  const reportRoot = join(config.evidenceRoot, request.requestId)
  mkdirSync(reportRoot, { mode: 0o700 }) // existing/unknown request results never overwritten
  syncDirectory(config.evidenceRoot)
  const work = mkdtempSync(join(config.workRoot, "candidate-"))
  const snapshot = join(work, "candidate.js"), scratch = join(work, "scratch")
  writeFileSync(snapshot, compiled, { mode: 0o400, flag: "wx" }); mkdirSync(scratch, { mode: 0o700 })
  const startedAt = new Date().toISOString()
  const observations: Array<Record<string, unknown>> = []
  let executionError: string | undefined
  try {
    for (let caseIndex = 0; caseIndex < loaded.tests.length; caseIndex++) {
      const item = loaded.tests[caseIndex], nonce = randomUUID()
      const execution: CaseExecution = { runtime: config.runtime.path, runner: config.runner.path, compiled: snapshot, scratch,
        timeoutMs: 3000, request: { nonce, caseIndex, input: item.input, compiledDigest } }
      const profileDigest = fixtureSandbox(execution).digest
      const output = await executor(execution)
      let matched = false, observation: unknown = null, reason: string | undefined
      if (output.code !== 0 || output.signal || output.error || output.timedOut || output.overflow) reason = "child_did_not_complete"
      else {
        try {
          const result = JSON.parse(output.stdout)
          exact(result, ["schemaVersion", "nonce", "caseIndex", "compiledDigest", "observation"])
          if (result.schemaVersion !== "fixture-observation/1" || result.nonce !== nonce || result.caseIndex !== caseIndex || result.compiledDigest !== compiledDigest)
            throw new Error("observation_binding_mismatch")
          observation = result.observation
          matched = canonicalJson(observation) === canonicalJson(item.expected)
          if (!matched) reason = "case_failed"
        } catch { reason = "invalid_child_observation" }
      }
      observations.push({ id: item.id, caseIndex, nonce, input: item.input, expected: item.expected, observation, matched, reason,
        process: { code: output.code, signal: output.signal, error: output.error, timedOut: output.timedOut, overflow: output.overflow },
        stdout: output.stdout, stderr: output.stderr, stdoutDigest: byteDigest(output.stdout), stderrDigest: byteDigest(output.stderr), profileDigest })
      if (reason && reason !== "case_failed") break
    }
    if (!readFileSync(snapshot).equals(compiled)) throw new Error("compiled_candidate_changed")
    // Reopen every protected input after execution. No key or parent state was
    // passed into the child's environment or file read allowlist.
    const current = loadConfiguration(configPathOf(loaded), config.signerUid)
    if (current.configDigest !== loaded.configDigest) throw new Error("configuration_changed")
  } catch (error) { executionError = error instanceof Error ? error.message : "verifier_error" }
  finally { rmSync(work, { recursive: true, force: true }) }
  const passed = !executionError && observations.length === 12 && observations.every((item) => item.matched)
  const report = { schemaVersion: "fixture-verification-evidence/1", requestId: request.requestId, verifierId: config.verifierId,
    binding: config.binding, candidateDigest: request.candidateDigest, compiledDigest,
    sourceRef: `${pathToFileURL(config.source.path)}#${config.source.digest}`, testsDigest: config.tests.digest,
    runtimeDigest: config.runtime.digest, runnerDigest: config.runner.digest, configDigest: loaded.configDigest,
    startedAt, finishedAt: new Date().toISOString(), status: passed ? "passed" : "failed", observations, executionError,
    scope: "M0 pure sumEvenThrough code-execution task only; not the M0 milestone or M1 diagnostics feature",
    isolation: { network: executor === executeCase ? "none" : "unverified-test-seam", processFork: executor === executeCase ? "denied" : "unverified-test-seam",
      exec: executor === executeCase ? "fixed-runtime-only" : "unverified-test-seam", signerUid: process.getuid?.(), candidateEvaluatedInSigner: false,
      childContainsKey: false, protectedTestsEvaluatedBy: "signer-parent", candidateLanguage: "restricted-pure-function", osAccountBoundaryTestedHere: false } }
  const evidenceBytes = Buffer.from(canonicalJson(report) + "\n")
  const evidencePath = join(reportRoot, "evidence.json")
  persist(evidencePath, evidenceBytes) // durable file and directory before signing
  const evidence = { ref: `${pathToFileURL(evidencePath)}#${byteDigest(evidenceBytes)}`, digest: byteDigest(evidenceBytes) }
  if (!passed) return { schemaVersion: "verify-candidate-response/1", requestId: request.requestId, status: "failed", evidence }
  const attestationPath = join(reportRoot, "signed-check.json")
  const gate = { schemaVersion: "gate/1", decisionId: randomUUID(), scope: "delivery",
    goal: { taskId: config.binding.taskId, goalRevision: config.binding.goalRevision, acceptanceDigest: config.binding.acceptanceDigest },
    inputEvidenceDigests: [evidence.digest], verifier: { id: "loopit-signer", version: "m0-fixture-verifier/1", signatureRef: pathToFileURL(attestationPath).href },
    decidedAt: report.finishedAt, results: [{ criterionId: "M0-CODE-01", outcome: "passed", evidenceRefs: [evidence.ref] }],
    uncovered: [], verdict: "passed" }
  const parsedGate = parse("gate", gate)
  if (!parsedGate.ok || validateGate(parsedGate.value, loaded.goal).length) throw new Error("gate_contract_invalid")
  const payload = { schemaVersion: "signed-fixture-check/1", checkId: randomUUID(), requestId: request.requestId,
    verifierId: config.verifierId, keyId: config.keyId, binding: config.binding, candidateDigest: request.candidateDigest,
    compiledDigest, testsDigest: config.tests.digest, runnerDigest: config.runner.digest, runtimeDigest: config.runtime.digest,
    evidence, gate: parsedGate.value, result: "passed", testsPassed: 12, observedAt: report.finishedAt,
    scope: "Delivery of this M0 code-execution task only; not M0 milestone or M1 feature acceptance" }
  const signedCheck = { payload, signature: sign(null, Buffer.from(canonicalJson(payload)), loaded.key).toString("base64") }
  persist(attestationPath, Buffer.from(canonicalJson(signedCheck) + "\n"))
  return { schemaVersion: "verify-candidate-response/1", requestId: request.requestId, status: "passed", evidence, signedCheck }
}

// The configuration source is part of the trusted library state, never input JSON.
const configurationPaths = new WeakMap<object, string>()
export function openVerifier(path = CONFIG_PATH, uid = SIGNER_UID) {
  const loaded = loadConfiguration(path, uid)
  configurationPaths.set(loaded, path)
  return loaded
}
function configPathOf(loaded: ReturnType<typeof loadConfiguration>) {
  const path = configurationPaths.get(loaded)
  if (!path) throw new Error("configuration_must_be_opened_by_verifier")
  return path
}

/** Caller supplies its own protected/pinned trust root, never one from the result. */
export function verifySignedCheck(value: { payload: Record<string, unknown>; signature: string }, publicKeyPem: string,
  expected: { binding: Binding; candidateDigest: string; keyId: string; testsDigest: string }) {
  try {
    const key = createPublicKey(publicKeyPem)
    return key.asymmetricKeyType === "ed25519" && byteDigest(key.export({ format: "der", type: "spki" })) === expected.keyId &&
      value.payload.schemaVersion === "signed-fixture-check/1" && value.payload.result === "passed" && value.payload.testsPassed === 12 &&
      value.payload.keyId === expected.keyId && value.payload.candidateDigest === expected.candidateDigest && value.payload.testsDigest === expected.testsDigest &&
      canonicalJson(value.payload.binding) === canonicalJson(expected.binding) &&
      verify(null, Buffer.from(canonicalJson(value.payload)), key, Buffer.from(value.signature, "base64"))
  } catch { return false }
}

export type FixtureAcceptanceWindow = { notBefore: string; deadlineAt: string; now?: string | number }
/** Acceptance adds evidence resolution and the trusted Run's original time
 * window to pure signature verification. Caller owns the window/trust anchor;
 * neither can be supplied by the candidate or attestation. No TTL is invented. */
export function acceptSignedFixtureCheck(value: unknown, evidenceBytes: Buffer | undefined, publicKeyPem: string,
  expected: Parameters<typeof verifySignedCheck>[2], window: FixtureAcceptanceWindow): { accepted: boolean; reason: string } {
  const reject = (reason: string) => ({ accepted: false, reason })
  try {
    if (!verifySignedCheck(value as Parameters<typeof verifySignedCheck>[0], publicKeyPem, expected)) return reject("signature_or_binding_invalid")
    const payload = (value as { payload: Record<string, any> }).payload
    if (!Buffer.isBuffer(evidenceBytes) || evidenceBytes.length > 1024 * 1024 || byteDigest(evidenceBytes) !== payload.evidence?.digest)
      return reject("evidence_missing_or_digest_invalid")
    const evidence = JSON.parse(evidenceBytes.toString("utf8")), gate = parse("gate", payload.gate)
    if (!gate.ok || gate.value.verdict !== "passed" || gate.value.scope !== "delivery" || gate.value.verifier.id !== "loopit-signer" ||
        evidence.schemaVersion !== "fixture-verification-evidence/1" || evidence.status !== "passed" || evidence.executionError !== undefined ||
        !Array.isArray(evidence.observations) || evidence.observations.length !== 12 || evidence.observations.some((x: any) =>
          x.matched !== true || x.process?.code !== 0 || x.process.signal !== null || x.process.timedOut || x.process.overflow) ||
        evidence.requestId !== payload.requestId || evidence.verifierId !== payload.verifierId ||
        canonicalJson(evidence.binding) !== canonicalJson(expected.binding) || evidence.candidateDigest !== expected.candidateDigest ||
        evidence.testsDigest !== expected.testsDigest || evidence.compiledDigest !== payload.compiledDigest ||
        evidence.runnerDigest !== payload.runnerDigest || evidence.runtimeDigest !== payload.runtimeDigest ||
        canonicalJson(gate.value.goal) !== canonicalJson({ taskId: expected.binding.taskId, goalRevision: expected.binding.goalRevision,
          acceptanceDigest: expected.binding.acceptanceDigest }) ||
        canonicalJson(gate.value.inputEvidenceDigests) !== canonicalJson([payload.evidence.digest]) ||
        new URL(payload.evidence.ref).hash !== `#${payload.evidence.digest}` ||
        canonicalJson(gate.value.results.map(x => x.criterionId).sort()) !== canonicalJson([...expected.binding.criterionIds].sort()) ||
        gate.value.uncovered.length || gate.value.results.some(x => x.outcome !== "passed" || canonicalJson(x.evidenceRefs) !== canonicalJson([payload.evidence.ref])))
      return reject("evidence_or_gate_binding_invalid")
    const time = (input: unknown) => typeof input === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input) ? Date.parse(input) : NaN
    const start = time(window.notBefore), deadline = time(window.deadlineAt)
    const now = window.now === undefined ? Date.now() : typeof window.now === "number" ? window.now : time(window.now)
    const observed = time(payload.observedAt), decided = time(gate.value.decidedAt), finished = time(evidence.finishedAt), began = time(evidence.startedAt)
    if (![start, deadline, now, observed, decided, finished, began].every(Number.isFinite) || start > deadline || now < start)
      return reject("acceptance_clock_invalid")
    if (observed !== decided || decided !== finished || began > finished) return reject("evidence_time_mismatch")
    if (began < start || observed < start) return reject("evidence_before_run")
    if (observed > now || began > now) return reject("evidence_from_future")
    if (observed > deadline || now > deadline) return reject("acceptance_deadline_exceeded")
    return { accepted: true, reason: "accepted" }
  } catch { return reject("acceptance_input_invalid") }
}
