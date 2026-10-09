import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canonicalJson, digestOf } from "../src/digest"
import { checkM0Milestone, M0_REQUIRED_TESTS, sha256File, type M0CheckOptions } from "../src/milestone-check"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const now = "2026-10-09T09:00:00Z"

// Synthetic artifacts and ephemeral same-user keys test admission logic only.
// They are not M0 implementation evidence or proof of verifier deployment.
function fixture(costPolicy: { allowUnknownCost: boolean; maxUsd?: number } = { allowUnknownCost: false, maxUsd: 10 }) {
  const root = mkdtempSync(join(tmpdir(), "m0-check-")); dirs.push(root)
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const goal = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/valid/goal.json"), "utf8"))
  goal.resources.workerCapabilities = ["runtime.processTreeControl", "sandbox.userIsolation"]
  const write = (name: string, data: unknown) => writeFileSync(join(root, name), JSON.stringify(data, null, 2))
  write("cost-policy.json", { schemaVersion: "cost-policy/1", ...costPolicy })
  goal.costBudgetRef = `budget://operator-fixture#${sha256File(join(root, "cost-policy.json"))}`
  write("goal.json", goal)
  writeFileSync(join(root, "spec.md"), "Synthetic M0 specification fixture, not production evidence")
  const binding = { runId: "run-fixture", taskId: goal.taskId, goalRevision: goal.goalRevision,
    goalDigest: digestOf(goal), acceptanceDigest: digestOf(goal.acceptance), sourceRevision: "1".repeat(40), specDigest: sha256File(join(root, "spec.md")) }
  const artifacts: Array<{ ref: string; path: string; digest: string }> = []
  const add = (ref: string, path: string, data?: unknown) => {
    if (data !== undefined) write(path, data)
    artifacts.push({ ref, path, digest: sha256File(join(root, path)) })
  }
  add("artifact://goal", "goal.json")
  add("artifact://deliverable", "deliverable.json", { fixture: true })
  const testResults = M0_REQUIRED_TESTS.map((testId) => {
    add(`artifact://raw-${testId}`, `raw-${testId}.json`, { fixture: true, testId, observed: "expected synthetic outcome" })
    add(`artifact://evidence-${testId}`, `${testId}.json`, {
      schemaVersion: "m0-evidence/1", ...binding, testId, verifierId: "fixture-verifier", outcome: "passed",
      observedAt: "2026-10-09T08:00:00Z", expiresAt: "2026-10-10T08:00:00Z",
      sampleCount: 1, passed: 1, failed: 0, blocked: 0, notRun: 0, rawArtifactRefs: [`artifact://raw-${testId}`],
    })
    return { testId, required: true, outcome: "passed", evidenceRef: `artifact://evidence-${testId}` }
  })
  add("artifact://results", "results.json", { schemaVersion: "m0-results/1", ...binding, results: testResults })
  add("artifact://capabilities", "capabilities.json", { schemaVersion: "m0-capabilities/1", ...binding,
    capabilities: goal.resources.workerCapabilities.map((id: string) => ({ id, status: "supported", evidenceRefs: ["artifact://evidence-M0-A07"] })) })
  add("artifact://metrics", "metrics.json", { schemaVersion: "m0-metrics/1", ...binding,
    usage: { cost: { known: true, usd: 0 }, wallMs: 15, humanInterventions: 0 } })
  const manifest: any = { schemaVersion: "milestone/1", milestone: "M0", specDigest: binding.specDigest, sourceRevision: binding.sourceRevision,
    contractVersions: ["goal/1", "milestone/1"], upstreamManifestRefs: [], inputRefs: ["artifact://goal"], outputRefs: ["artifact://deliverable"],
    capabilityMatrixRef: "artifact://capabilities", testResults, testResultsRef: "artifact://results", metricsRef: "artifact://metrics",
    unresolvedConstraints: [], issuer: { kind: "verifier", id: "fixture-verifier" }, issuedAt: "2026-10-09T08:30:00Z", verdict: "passed" }
  const attestation: any = { schemaVersion: "m0-attestation/1", ...binding, goalRef: "artifact://goal", artifacts,
    verifierId: "fixture-verifier", issuedAt: "2026-10-09T08:30:00Z", expiresAt: "2026-10-10T08:00:00Z",
    resourcesClean: true, externalOperationsReconciled: true }
  const seal = () => {
    write("manifest.json", manifest)
    attestation.manifestDigest = sha256File(join(root, "manifest.json"))
    for (const artifact of artifacts) artifact.digest = sha256File(join(root, artifact.path))
    const { signature: removed, ...payload } = attestation
    attestation.signature = { algorithm: "Ed25519", value: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64") }
    write("attestation.json", attestation)
  }
  seal()
  const options: M0CheckOptions = { manifestPath: join(root, "manifest.json"), attestationPath: join(root, "attestation.json"),
    goalPath: join(root, "goal.json"), costPolicyPath: join(root, "cost-policy.json"), specPath: join(root, "spec.md"),
    expectedRunId: binding.runId, expectedSourceRevision: binding.sourceRevision, sourceDirty: false,
    trustedVerifier: { id: "fixture-verifier", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() },
    independentVerifierEstablished: true, now }
  const change = (path: string, update: (data: any) => void) => { const data = JSON.parse(readFileSync(join(root, path), "utf8")); update(data); write(path, data) }
  return { root, options, manifest, attestation, artifacts, seal, change, write }
}
const codes = (result: ReturnType<typeof checkM0Milestone>) => result.issues.map((issue) => issue.code)

describe("M0 evidence admission (synthetic trust fixtures)", () => {
  test("accepts all 15 complete signed evidence chains only under an established external boundary", () => {
    const f = fixture(), result = checkM0Milestone(f.options)
    expect(result.issues).toEqual([])
    expect(result.verdict).toBe("passed")
    expect(result.cases.every((item) => item.outcome === "passed")).toBe(true)
    expect(result.signatureVerified).toBe(true)
    expect(result.checkedArtifacts.length).toBe(35)
    const nativeDefault = checkM0Milestone({ ...f.options, independentVerifierEstablished: undefined })
    expect(nativeDefault.evidenceVerdict).toBe("passed")
    expect(nativeDefault.verdict).toBe("blocked")
    expect(codes(nativeDefault)).toContain("verifier_boundary_unverified")
  })
  test("issuer text or a self-signed key does not establish trust", () => {
    const f = fixture()
    expect(codes(checkM0Milestone({ ...f.options, trustedVerifier: undefined }))).toContain("trusted_verifier_missing")
    const wrongKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()
    expect(codes(checkM0Milestone({ ...f.options, trustedVerifier: { id: "fixture-verifier", publicKeyPem: wrongKey } }))).toContain("signature_invalid")
    f.attestation.signature.value = Buffer.alloc(64).toString("base64"); f.write("attestation.json", f.attestation)
    expect(checkM0Milestone(f.options).verdict).toBe("failed")
  })
  test("missing inputs remain blocked", () => {
    const f = fixture()
    const result = checkM0Milestone({ ...f.options, manifestPath: undefined, attestationPath: undefined, goalPath: undefined, expectedRunId: undefined, trustedVerifier: undefined })
    expect(result.verdict).toBe("blocked")
    expect(result.cases.every((item) => item.outcome === "notRun")).toBe(true)
  })
  test("required=false or omitted A15 cannot shrink M0 acceptance", () => {
    const f = fixture()
    f.manifest.testResults.at(-1).required = false; f.seal()
    expect(codes(checkM0Milestone(f.options))).toContain("required_test_missing")
    f.manifest.testResults.pop(); f.seal()
    expect(checkM0Milestone(f.options).verdict).not.toBe("passed")
  })
  test("unknown/notRun/failed evidence cannot be turned into a passing manifest", () => {
    for (const outcome of ["unknown", "notRun", "failed"]) {
      const f = fixture()
      f.change("M0-A04.json", (data) => { data.outcome = outcome; data.passed = 0; data[outcome === "failed" ? "failed" : "notRun"] = 1 }); f.seal()
      const result = checkM0Milestone(f.options)
      expect(result.verdict).toBe(outcome === "failed" ? "failed" : "blocked")
      expect(codes(result)).toContain("evidence_not_passed")
      expect(result.cases.find((item) => item.testId === "M0-A04")?.outcome).not.toBe("passed")
    }
  })
  test("wrong schema versions are rejected even with a valid signer", () => {
    const f = fixture(); f.change("M0-A01.json", (data) => { data.schemaVersion = "m0-evidence/2" }); f.seal()
    expect(codes(checkM0Milestone(f.options))).toContain("schema_invalid")
    f.manifest.schemaVersion = "milestone/2"; f.seal()
    expect(codes(checkM0Milestone(f.options))).toContain("incompatible_schema_version")
  })
  test("run, goal revision and acceptance content cannot be rebound", () => {
    const f = fixture()
    f.change("M0-A09.json", (data) => { data.runId = "other-run"; data.goalRevision += 1; data.acceptanceDigest = `sha256:${"f".repeat(64)}` }); f.seal()
    expect(codes(checkM0Milestone(f.options)).filter((code) => code === "binding_mismatch").length).toBe(3)
    expect(checkM0Milestone({ ...f.options, expectedRunId: "new-run" }).verdict).toBe("failed")
  })
  test("artifact deletion and byte tampering are detected by reading actual files", () => {
    const f = fixture()
    writeFileSync(join(f.root, "raw-M0-A08.json"), "tampered")
    expect(codes(checkM0Milestone(f.options))).toContain("artifact_digest_mismatch")
    rmSync(join(f.root, "raw-M0-A08.json"))
    expect(codes(checkM0Milestone(f.options))).toContain("artifact_missing_or_unsafe")
  })
  test("oversized structured artifacts cannot skip inspection even when their full bytes are signed", () => {
    for (const path of ["M0-A01.json", "results.json", "capabilities.json", "metrics.json", "goal.json"]) {
      const f = fixture()
      const artifact = f.artifacts.find((item) => item.path === path)!
      // Keep the independently supplied goal small; only its signed artifact is oversized.
      const oversized = `${readFileSync(join(f.root, path), "utf8")}${" ".repeat(8 * 1024 * 1024)}`
      artifact.path = `oversized-${path}`
      writeFileSync(join(f.root, artifact.path), oversized)
      f.seal()
      const result = checkM0Milestone(f.options)
      expect(result.signatureVerified).toBe(true)
      expect(result.verdict).toBe("blocked")
      expect(codes(result)).toContain("artifact_content_unavailable")
      if (path === "M0-A01.json") {
        expect(result.cases[0].outcome).toBe("blocked")
        expect(codes(result)).toContain("required_evidence_incomplete")
      }
    }
  })
  test("large raw observations may be hash-verified without JSON parsing", () => {
    const f = fixture()
    writeFileSync(join(f.root, "raw-M0-A01.json"), "raw observation\n".repeat(600_000)); f.seal()
    expect(checkM0Milestone(f.options).verdict).toBe("passed")
  })
  test("manifest bytes cannot change after attestation", () => {
    const f = fixture(); writeFileSync(join(f.root, "manifest.json"), JSON.stringify(f.manifest))
    expect(codes(checkM0Milestone(f.options))).toContain("manifest_digest_mismatch")
  })
  test("a raw-artifact alias cannot reuse the evidence report itself", () => {
    const f = fixture()
    const raw = f.artifacts.find((item) => item.ref === "artifact://raw-M0-A07")!
    raw.path = "M0-A07.json"; f.seal()
    expect(codes(checkM0Milestone(f.options))).toContain("evidence_self_reference")
  })
  test("relative traversal and symlinks cannot escape the operator artifact root", () => {
    const f = fixture(), outside = mkdtempSync(join(tmpdir(), "m0-outside-")); dirs.push(outside)
    writeFileSync(join(outside, "raw.json"), "outside")
    symlinkSync(outside, join(f.root, "escape"))
    const raw = f.artifacts.find((item) => item.ref === "artifact://raw-M0-A07")!
    raw.path = "escape/raw.json"; f.seal()
    expect(codes(checkM0Milestone(f.options))).toContain("artifact_missing_or_unsafe")
    raw.path = `../${outside.split("/").at(-1)}/raw.json`; f.seal()
    expect(checkM0Milestone(f.options).verdict).toBe("blocked")
  })
  test("expired evidence, unsupported capabilities, unknown cost and unclean resources block", () => {
    const f = fixture()
    f.change("M0-A12.json", (data) => { data.expiresAt = "2026-10-09T08:59:00Z" })
    f.change("capabilities.json", (data) => { data.capabilities[0].status = "unverified" })
    f.change("metrics.json", (data) => { data.usage.cost = { known: false, reason: "not observed" } })
    f.attestation.resourcesClean = false; f.seal()
    expect(codes(checkM0Milestone(f.options))).toEqual(expect.arrayContaining(["evidence_expired_or_future", "capability_unverified", "cost_unknown", "cleanup_or_reconciliation_missing"]))
    expect(checkM0Milestone(f.options).verdict).toBe("blocked")
  })
  test("unknown OAuth cost is allowed only by a frozen operator policy without a USD cap", () => {
    const f = fixture({ allowUnknownCost: true })
    f.change("metrics.json", (data) => { data.usage.cost = { known: false, reason: "OAuth subscription does not report USD usage" } }); f.seal()
    const result = checkM0Milestone(f.options)
    expect(result.verdict).toBe("passed")
    expect(result.costAssessment).toEqual({ policy: { schemaVersion: "cost-policy/1", allowUnknownCost: true },
      observed: { known: false, reason: "OAuth subscription does not report USD usage" }, usdCap: "notConfigured" })
    // Even an explicit unknown-cost exception cannot prove a hard USD cap.
    const capped = fixture({ allowUnknownCost: true, maxUsd: 10 })
    capped.change("metrics.json", (data) => { data.usage.cost = { known: false, reason: "OAuth" } }); capped.seal()
    const cappedResult = checkM0Milestone(capped.options)
    expect(cappedResult.verdict).toBe("blocked")
    expect(cappedResult.costAssessment?.usdCap).toBe("unknown")
    expect(codes(cappedResult)).toContain("cost_cap_unverifiable")
  })
  test("cost policy must be a separate operator input pinned by the goal, and known costs must respect its cap", () => {
    const f = fixture()
    expect(checkM0Milestone({ ...f.options, costPolicyPath: undefined }).verdict).toBe("blocked")
    f.change("cost-policy.json", (data) => { data.allowUnknownCost = true })
    expect(codes(checkM0Milestone(f.options))).toContain("cost_policy_digest_mismatch")
    const capped = fixture()
    capped.change("metrics.json", (data) => { data.usage.cost.usd = 10.01 }); capped.seal()
    expect(codes(checkM0Milestone(capped.options))).toContain("cost_budget_exceeded")
    const selfDeclared = fixture()
    selfDeclared.change("metrics.json", (data) => { data.costPolicy = { allowUnknownCost: true }; data.usage.cost = { known: false, reason: "OAuth" } }); selfDeclared.seal()
    expect(codes(checkM0Milestone(selfDeclared.options))).toContain("schema_invalid")
  })
  test("an attested HEAD does not cover dirty or unverified worktree state", () => {
    const f = fixture()
    const dirty = checkM0Milestone({ ...f.options, sourceDirty: true })
    expect(dirty.signatureVerified).toBe(true)
    expect(dirty.verdict).toBe("blocked")
    expect(codes(dirty)).toContain("source_dirty")
    expect(codes(checkM0Milestone({ ...f.options, sourceDirty: undefined }))).toContain("source_state_unverified")
  })
})
