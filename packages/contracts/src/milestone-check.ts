import { createHash, createPublicKey, verify } from "node:crypto"
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { Schema } from "effect"
import { CapabilityStatus, Digest, Id, NonEmptyString, NonNegativeInt, PositiveInt, Ref, Timestamp, Usage } from "./common"
import { canonicalJson, digestOf } from "./digest"
import { checkFrozen } from "./goal"
import { parse, supportedVersions } from "./registry"
import { TestResultSummary } from "./milestone"

export const M0_REQUIRED_TESTS = Object.freeze(Array.from({ length: 15 }, (_, i) => `M0-A${String(i + 1).padStart(2, "0")}`))
const Binding = {
  runId: Id, taskId: Id, goalRevision: PositiveInt, goalDigest: Digest,
  acceptanceDigest: Digest, sourceRevision: NonEmptyString, specDigest: Digest,
}
const ArtifactRef = Schema.Struct({ ref: Ref, path: NonEmptyString, digest: Digest })
export const M0Attestation = Schema.Struct({
  schemaVersion: Schema.Literal("m0-attestation/1"), ...Binding,
  manifestDigest: Digest, goalRef: Ref, artifacts: Schema.Array(ArtifactRef),
  verifierId: Id, issuedAt: Timestamp, expiresAt: Timestamp,
  resourcesClean: Schema.Boolean, externalOperationsReconciled: Schema.Boolean,
  signature: Schema.Struct({ algorithm: Schema.Literal("Ed25519"), value: NonEmptyString }),
})
export const M0Evidence = Schema.Struct({
  schemaVersion: Schema.Literal("m0-evidence/1"), ...Binding, testId: Id, verifierId: Id,
  outcome: Schema.Literals(["passed", "failed", "blocked", "notRun", "unknown"]),
  observedAt: Timestamp, expiresAt: Timestamp,
  sampleCount: PositiveInt, passed: NonNegativeInt, failed: NonNegativeInt, blocked: NonNegativeInt, notRun: NonNegativeInt,
  rawArtifactRefs: Schema.Array(Ref).check(Schema.isMinLength(1)),
})
const M0Results = Schema.Struct({ schemaVersion: Schema.Literal("m0-results/1"), ...Binding, results: Schema.Array(TestResultSummary) })
const M0Capabilities = Schema.Struct({
  schemaVersion: Schema.Literal("m0-capabilities/1"), ...Binding,
  capabilities: Schema.Array(Schema.Struct({ id: Id, status: CapabilityStatus, evidenceRefs: Schema.Array(Ref) })),
})
const M0Metrics = Schema.Struct({ schemaVersion: Schema.Literal("m0-metrics/1"), ...Binding, usage: Usage })
export const M0CostPolicy = Schema.Struct({
  schemaVersion: Schema.Literal("cost-policy/1"), allowUnknownCost: Schema.Boolean,
  maxUsd: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
})

type CheckIssue = { code: string; path: string; message: string; severity: "failed" | "blocked" }
export interface M0CheckOptions {
  manifestPath?: string
  attestationPath?: string
  /** This root comes from the operator, never from the submitted manifest. */
  artifactRoot?: string
  goalPath?: string
  /** Operator-selected policy bytes, pinned by the independently supplied goal. */
  costPolicyPath?: string
  expectedRunId?: string
  expectedSourceRevision: string
  /** A commit alone cannot identify source with uncommitted changes. */
  sourceDirty?: boolean
  specPath: string
  trustedVerifier?: { id: string; publicKeyPem: string }
  /** Set only by a trusted host integration that independently proves the verifier boundary.
   * The CLI deliberately has no flag for this until that integration exists. */
  independentVerifierEstablished?: boolean
  now?: string
}

function fileSnapshot(path: string, capture = false) {
  // Nonblocking open prevents a submitted FIFO from hanging before fstat rejects it.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 1024 ** 3) throw new Error("Artifact must be a regular file no larger than 1 GiB")
    const hash = createHash("sha256"), chunk = Buffer.alloc(1024 * 1024)
    let bytes: number, size = 0
    const chunks: Buffer[] = []
    while ((bytes = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      size += bytes
      if (size > 1024 ** 3) throw new Error("Artifact exceeds 1 GiB")
      hash.update(chunk.subarray(0, bytes))
      if (capture && size <= 8 * 1024 * 1024) chunks.push(Buffer.from(chunk.subarray(0, bytes)))
    }
    return { digest: `sha256:${hash.digest("hex")}`, size,
      content: capture && size <= 8 * 1024 * 1024 ? Buffer.concat(chunks) : undefined }
  } finally { closeSync(fd) }
}
export const sha256File = (path: string) => fileSnapshot(path).digest

/** Reject-only admission until the host supplies an independently verified signer boundary.
 * Valid signatures authenticate a trusted verifier's reports; they do not themselves
 * prove physical tests happened or that a same-user test key is an independent service. */
export function checkM0Milestone(options: M0CheckOptions) {
  const issues: CheckIssue[] = []
  const now = options.now ?? new Date().toISOString()
  const add = (code: string, path: string, message: string, severity: CheckIssue["severity"] = "blocked") => issues.push({ code, path, message, severity })
  const checkedArtifacts: Array<{ ref: string; path: string; digest: string; bytes: number }> = []
  const cases = M0_REQUIRED_TESTS.map((testId) => ({ testId, outcome: "notRun" as string,
    declaredOutcome: undefined as string | undefined, evidenceRef: undefined as string | undefined }))
  let signatureVerified = false
  let manifestDigest: string | undefined
  let specDigest: string | undefined
  let costAssessment: { policy: typeof M0CostPolicy.Type; observed: typeof Usage.Type.cost;
    usdCap: "notConfigured" | "unknown" | "within" | "exceeded" } | undefined
  const inputDigests = new Map<string, string>()
  const readJson = (path: string | undefined, label: string): unknown => {
    if (!path) { add("input_missing", label, `${label} is required`); return }
    try {
      const snapshot = fileSnapshot(path, true)
      if (!snapshot.content) throw new Error("JSON input exceeds 8 MiB")
      inputDigests.set(label, snapshot.digest)
      return JSON.parse(snapshot.content.toString())
    } catch (error) { add("input_unreadable", label, `${label} is missing, invalid JSON, or unreadable`); return }
  }
  const decode = <T>(schema: Schema.Codec<T, any, never, never>, value: unknown, label: string): T | undefined => {
    if (value === undefined) return
    try { return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" }) }
    catch { add("schema_invalid", label, `${label} has an unsupported schema version or invalid fields`, "failed"); return }
  }
  const expired = (start: string, end: string, label: string) => {
    const startMs = Date.parse(start), endMs = Date.parse(end), nowMs = Date.parse(now)
    if (![startMs, endMs, nowMs].every(Number.isFinite) || startMs > nowMs || endMs <= nowMs || endMs <= startMs)
      add("evidence_expired_or_future", label, "Observation/attestation time window is invalid or expired")
  }
  const rawManifest = readJson(options.manifestPath, "manifest")
  const manifestResult = rawManifest === undefined ? undefined : parse("milestone", rawManifest)
  const manifest = manifestResult?.ok ? manifestResult.value : undefined
  if (manifestResult && !manifestResult.ok) for (const item of manifestResult.issues) add(item.code, `manifest.${item.path}`, item.message, "failed")
  if (manifest && manifest.milestone !== "M0") add("wrong_milestone", "manifest.milestone", "Only M0 is supported", "failed")
  if (options.manifestPath && rawManifest !== undefined) manifestDigest = inputDigests.get("manifest")
  try { specDigest = sha256File(options.specPath) } catch { add("spec_unreadable", "spec", "The operator's M0 specification could not be read") }
  const rawGoal = readJson(options.goalPath, "goal")
  const goalResult = rawGoal === undefined ? undefined : parse("goal", rawGoal)
  const goal = goalResult?.ok ? goalResult.value : undefined
  if (goalResult && !goalResult.ok) for (const item of goalResult.issues) add(item.code, `goal.${item.path}`, item.message, "failed")
  if (goal) {
    for (const item of checkFrozen(goal)) add(item.code, `goal.${item.path}`, item.message)
    if (goal.targetMatrix.length === 0) add("target_unfrozen", "goal.targetMatrix", "M0 requires the selected target device route")
    if (!goal.resources?.workerCapabilities?.length) add("capabilities_unfrozen", "goal.resources.workerCapabilities", "Required capabilities must be frozen outside the submitted report")
  }
  const costPolicy = decode(M0CostPolicy, readJson(options.costPolicyPath, "costPolicy"), "costPolicy")
  if (goal && costPolicy && goal.costBudgetRef.split("#")[1] !== inputDigests.get("costPolicy"))
    add("cost_policy_digest_mismatch", "goal.costBudgetRef", "Frozen costBudgetRef must pin the operator-supplied policy file's exact bytes", "failed")
  if (!options.expectedRunId) add("run_binding_missing", "runId", "An expected Run ID must be supplied by the operator")
  if (!/^[0-9a-f]{40}$/.test(options.expectedSourceRevision)) add("source_unpinned", "sourceRevision", "Expected source must be a complete commit ID")
  if (options.sourceDirty === true) add("source_dirty", "sourceRevision", "Uncommitted source changes are not bound by the attested commit")
  else if (options.sourceDirty !== false) add("source_state_unverified", "sourceRevision", "The trusted host must confirm the source worktree is clean")
  if (!options.trustedVerifier) add("trusted_verifier_missing", "trust", "No operator/CI-configured trusted verifier public key")
  if (!options.independentVerifierEstablished) add("verifier_boundary_unverified", "trust", "Independent Worker/Verifier identity and key custody have not been established by a trusted host integration")
  const rawAttestation = readJson(options.attestationPath, "attestation")
  const attestation = decode(M0Attestation, rawAttestation, "attestation")
  const expected = goal ? {
    runId: options.expectedRunId, taskId: goal.taskId, goalRevision: goal.goalRevision,
    goalDigest: digestOf(goal), acceptanceDigest: digestOf(goal.acceptance),
    sourceRevision: options.expectedSourceRevision, specDigest,
  } : undefined
  const checkBinding = (value: Record<string, unknown>, label: string) => {
    if (!expected) return
    for (const [key, wanted] of Object.entries(expected)) if (wanted !== undefined && value[key] !== wanted)
      add("binding_mismatch", `${label}.${key}`, `${key} differs from the independently supplied Run/goal/spec/source`, "failed")
  }
  if (manifest) {
    if (manifest.sourceRevision !== options.expectedSourceRevision || manifest.specDigest !== specDigest)
      add("manifest_binding_mismatch", "manifest", "Manifest source/spec does not match the operator's current inputs", "failed")
    if (manifest.unresolvedConstraints.length) add("unresolved_constraints", "manifest.unresolvedConstraints", "Unresolved constraints prevent M0 completion")
    const allowedVersions = new Set(Object.values(supportedVersions()).flat())
    for (const version of manifest.contractVersions) if (!allowedVersions.has(version)) add("contract_version_unknown", "manifest.contractVersions", `Unsupported contract ${version}`, "failed")
    for (const version of ["goal/1", "milestone/1"]) if (!manifest.contractVersions.includes(version)) add("contract_version_missing", "manifest.contractVersions", `Required contract ${version} is missing`)
    const seen = new Set<string>()
    for (const test of manifest.testResults) {
      if (seen.has(test.testId)) add("duplicate_test", "manifest.testResults", `${test.testId} is repeated`, "failed")
      seen.add(test.testId)
    }
    for (const result of cases) {
      const test = manifest.testResults.find((item) => item.testId === result.testId)
      if (!test || !test.required || !test.evidenceRef) add("required_test_missing", result.testId, "All M0-A01–A15 must be required and reference evidence")
      result.declaredOutcome = test?.outcome
      result.evidenceRef = test?.evidenceRef
      if (test && test.outcome !== "passed") add("required_test_not_passed", result.testId, `${result.testId} is ${test.outcome}`, test.outcome === "failed" ? "failed" : "blocked")
    }
  }
  const artifactBytes = new Map<string, Buffer>()
  const artifactDigests = new Map<string, string>()
  if (attestation) {
    checkBinding(attestation, "attestation")
    expired(attestation.issuedAt, attestation.expiresAt, "attestation")
    if (attestation.manifestDigest !== manifestDigest) add("manifest_digest_mismatch", "attestation.manifestDigest", "Manifest bytes do not match the signed digest", "failed")
    if (!attestation.resourcesClean || !attestation.externalOperationsReconciled)
      add("cleanup_or_reconciliation_missing", "attestation", "Resources and external operations must be independently reconciled")
    if (manifest && (manifest.issuer.kind !== "verifier" || manifest.issuer.id !== attestation.verifierId)) add("issuer_mismatch", "manifest.issuer", "Manifest issuer differs from attesting verifier", "failed")
    if (options.trustedVerifier) {
      try {
        const key = createPublicKey(options.trustedVerifier.publicKeyPem)
        const signature = Buffer.from(attestation.signature.value, "base64")
        const { signature: omitted, ...payload } = rawAttestation as Record<string, unknown>
        if (key.asymmetricKeyType !== "ed25519" || options.trustedVerifier.id !== attestation.verifierId || signature.length !== 64 || signature.toString("base64") !== attestation.signature.value ||
            !verify(null, Buffer.from(canonicalJson(payload)), key, signature)) throw new Error("invalid attestation signature")
        signatureVerified = true
      } catch { add("signature_invalid", "attestation.signature", "Signature does not verify under the explicitly trusted Ed25519 verifier key", "failed") }
    }
    let artifactRoot: string | undefined
    try { artifactRoot = realpathSync(options.artifactRoot ?? dirname(options.attestationPath!)) } catch { add("artifact_root_missing", "artifacts", "Artifact root does not exist") }
    if (attestation.artifacts.length > 2048) add("artifact_limit", "attestation.artifacts", "At most 2048 artifacts are accepted", "failed")
    else for (const artifact of attestation.artifacts) {
      if (artifactDigests.has(artifact.ref)) { add("duplicate_artifact_ref", artifact.ref, "Artifact reference is repeated", "failed"); continue }
      artifactDigests.set(artifact.ref, artifact.digest)
      if (!artifactRoot) continue
      try {
        if (isAbsolute(artifact.path) || artifact.path.includes("\\") || artifact.path.includes("\0") || artifact.path.split("/").includes("..")) throw new Error("unsafe path")
        const path = realpathSync(resolve(artifactRoot, artifact.path))
        const rel = relative(artifactRoot, path)
        if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("escaping path")
        const snapshot = fileSnapshot(path, true)
        if (snapshot.digest !== artifact.digest) { add("artifact_digest_mismatch", artifact.ref, "Artifact bytes differ from signed digest", "failed"); continue }
        checkedArtifacts.push({ ref: artifact.ref, path, digest: snapshot.digest, bytes: snapshot.size })
        if (snapshot.content) artifactBytes.set(artifact.ref, snapshot.content)
      } catch { add("artifact_missing_or_unsafe", artifact.ref, "Artifact is missing, unreadable, non-regular, oversized or escapes its trusted root") }
    }
  }
  const verifiedRefs = new Set(checkedArtifacts.map((item) => item.ref))
  const requireRef = (ref: string, label: string) => {
    if (!verifiedRefs.has(ref)) add("artifact_reference_unverified", label, `Required artifact ${ref} has no verified file and digest`)
  }
  const structuredBytes = (ref: string, label: string) => {
    requireRef(ref, label)
    const bytes = artifactBytes.get(ref)
    if (!bytes) add("artifact_content_unavailable", label, "Required structured artifact has no inspectable content (JSON limit: 8 MiB)")
    return bytes
  }
  const loadArtifact = <T>(ref: string, schema: Schema.Codec<T, any, never, never>, label: string): T | undefined => {
    const bytes = structuredBytes(ref, label)
    if (!bytes) return
    try { return decode(schema, JSON.parse(bytes.toString()), label) }
    catch { add("artifact_json_invalid", label, "Artifact is not valid JSON", "failed"); return }
  }
  if (manifest && attestation) {
    const refs = [...manifest.inputRefs, ...manifest.outputRefs, manifest.capabilityMatrixRef, manifest.testResultsRef, manifest.metricsRef, attestation.goalRef]
    for (const ref of refs) requireRef(ref, ref)
    if (!manifest.inputRefs.includes(attestation.goalRef)) add("goal_input_missing", "manifest.inputRefs", "Frozen goal must be an explicit manifest input")
    if (!manifest.outputRefs.length) add("outputs_missing", "manifest.outputRefs", "Milestone deliverables are missing")
    const goalBytes = structuredBytes(attestation.goalRef, "goalArtifact")
    if (goal && goalBytes) {
      try {
        const parsed = parse("goal", JSON.parse(goalBytes.toString()))
        if (!parsed.ok || digestOf(parsed.value) !== digestOf(goal)) add("goal_artifact_mismatch", attestation.goalRef, "Signed goal artifact differs from independently supplied frozen goal", "failed")
      } catch { add("goal_artifact_invalid", attestation.goalRef, "Goal artifact cannot be parsed", "failed") }
    }
    for (const upstream of manifest.upstreamManifestRefs) {
      requireRef(upstream.ref, "upstreamManifestRefs")
      if (artifactDigests.get(upstream.ref) !== upstream.digest) add("upstream_digest_mismatch", upstream.ref, "Upstream digest does not match signed artifact", "failed")
    }
    for (const result of cases) {
      if (!result.evidenceRef) continue
      const issueStart = issues.length
      const evidence = loadArtifact(result.evidenceRef, M0Evidence, result.testId)
      if (!evidence) { result.outcome = "blocked"; continue }
      checkBinding(evidence, result.testId)
      expired(evidence.observedAt, evidence.expiresAt, result.testId)
      if (evidence.testId !== result.testId || evidence.verifierId !== attestation.verifierId) add("evidence_identity_mismatch", result.testId, "Evidence belongs to a different acceptance or verifier", "failed")
      if (evidence.outcome !== "passed") add("evidence_not_passed", result.testId, `Evidence is ${evidence.outcome}`, evidence.outcome === "failed" ? "failed" : "blocked")
      if (evidence.passed !== evidence.sampleCount || evidence.failed || evidence.blocked || evidence.notRun)
        add("evidence_samples_incomplete", result.testId, "Every required sample must have passed; unknown/skipped samples cannot count")
      for (const ref of evidence.rawArtifactRefs) {
        requireRef(ref, `${result.testId}.rawArtifactRefs`)
        if (checkedArtifacts.find((item) => item.ref === ref)?.bytes === 0)
          add("raw_artifact_empty", result.testId, "An empty file cannot serve as an observation artifact")
        if (ref === result.evidenceRef || artifactDigests.get(ref) === artifactDigests.get(result.evidenceRef))
          add("evidence_self_reference", result.testId, "A report cannot serve as its own raw artifact, including through an alias", "failed")
      }
      const caseIssues = issues.slice(issueStart)
      result.outcome = caseIssues.some((item) => item.severity === "failed") ? "failed"
        : !signatureVerified || caseIssues.length || result.declaredOutcome !== "passed" ? "blocked" : "passed"
    }
    const results = loadArtifact(manifest.testResultsRef, M0Results, "testResults")
    if (results) {
      checkBinding(results, "testResults")
      if (canonicalJson(results.results) !== canonicalJson(manifest.testResults)) add("test_results_mismatch", "testResults", "Persisted results do not equal manifest results", "failed")
    }
    const capabilities = loadArtifact(manifest.capabilityMatrixRef, M0Capabilities, "capabilities")
    if (capabilities) {
      checkBinding(capabilities, "capabilities")
      for (const required of goal?.resources?.workerCapabilities ?? []) {
        const matches = capabilities.capabilities.filter((item) => item.id === required)
        if (matches.length !== 1 || matches[0].status !== "supported" || !matches[0].evidenceRefs.length)
          add("capability_unverified", required, "Frozen required capability must have exactly one measured supported result with evidence")
        for (const ref of matches[0]?.evidenceRefs ?? []) requireRef(ref, required)
      }
    }
    const metrics = loadArtifact(manifest.metricsRef, M0Metrics, "metrics")
    if (metrics) {
      checkBinding(metrics, "metrics")
      if (costPolicy) {
        const cost = metrics.usage.cost
        const usdCap = costPolicy.maxUsd === undefined ? "notConfigured" : !cost.known ? "unknown"
          : cost.usd <= costPolicy.maxUsd ? "within" : "exceeded"
        costAssessment = { policy: costPolicy, observed: cost, usdCap }
        if (!cost.known && !costPolicy.allowUnknownCost)
          add("cost_unknown", "metrics.usage.cost", "The frozen operator policy does not permit unknown cost")
        if (usdCap === "unknown") add("cost_cap_unverifiable", "metrics.usage.cost", "Unknown USD cost cannot establish compliance with a hard USD cap")
        if (usdCap === "exceeded") add("cost_budget_exceeded", "metrics.usage.cost", "Observed USD cost exceeds the frozen policy limit", "failed")
      }
    }
  }
  for (const result of cases) if (result.outcome !== "passed")
    add("required_evidence_incomplete", result.testId, "All 15 required acceptance cases must independently resolve to passed")
  const contentIssues = issues.filter((item) => item.code !== "verifier_boundary_unverified")
  const verdictFor = (items: CheckIssue[]) => items.some((item) => item.severity === "failed") ? "failed" as const : items.length ? "blocked" as const : "passed" as const
  return {
    schemaVersion: "m0-check-result/1", milestone: "M0", checkedAt: now,
    verdict: verdictFor(issues), evidenceVerdict: verdictFor(contentIssues), signatureVerified,
    independentVerifierEstablished: options.independentVerifierEstablished === true,
    manifestDigest, specDigest, costPolicyDigest: inputDigests.get("costPolicy"), costAssessment,
    requiredTests: M0_REQUIRED_TESTS, cases, checkedArtifacts, issues,
    limitations: ["Cryptographic verification authenticates the configured verifier's report, not the physical truth of observations.",
      "Same-user fixture keys only test the cryptographic path; independent Worker/Verifier deployment must be established separately."],
  }
}
