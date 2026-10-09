import { afterEach, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { canonicalJson, digestOf } from "../../contracts/src/digest"
import { byteDigest } from "../src/service"
import { DEPLOYMENT_JOB, DEPLOYMENT_ROLES, deploymentBytes, deploymentScopeMatches, readVerifierDeployment,
  verifyDeploymentArchive, type DeploymentRole, type DeploymentTrust } from "../src/deployment"

const cleanup: string[] = []
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }) })
const hash = (text: string) => byteDigest(text)
function fixture() {
  // Synthetic conformance data and ephemeral key, never an independently
  // deployed service. Production fixed-root loading cannot accept this index.
  const root = realpathSync(mkdtempSync("/private/tmp/deployment-unit-")); cleanup.push(root)
  const raw = {} as Record<DeploymentRole, Buffer>, put = (role: DeploymentRole, value: unknown) => raw[role] = Buffer.from(JSON.stringify(value) + "\n")
  const { privateKey, publicKey } = generateKeyPairSync("ed25519"), keyId = byteDigest(publicKey.export({ type: "spki", format: "der" }))
  raw.publicKey = Buffer.from(publicKey.export({ type: "spki", format: "pem" }).toString())
  raw.source = Buffer.from("fixture baseline"); raw.tests = Buffer.from("fixed fixture tests"); raw.runner = Buffer.from("fixed fixture runner")
  const policy = `fixture://policy#${hash("policy")}`
  const goal = { schemaVersion: "goal/1", projectId: "project", taskId: "task", goalRevision: 1, objective: "synthetic deployment verification",
    scope: { repositoryRef: "fixture://repo", baseRevision: "1".repeat(40), allowedPaths: ["source.ts"], excluded: [] },
    acceptance: [{ id: "M0-CODE-01", expected: "fixed cases", verification: "executable", evidenceKinds: ["fixture"], requiredAtStage: "verification" }],
    targetMatrix: [], delivery: { artifactKinds: ["candidate"] }, policyRef: policy, budgets: { wallMinutes: 60, maxRepairCycles: 3, maxParallelWriters: 1 }, costBudgetRef: policy }
  put("goal", goal)
  const binding = { projectId: "project", taskId: "task", goalRevision: 1, runId: "run", goalDigest: digestOf(goal), sourceDigest: byteDigest(raw.source), acceptanceDigest: digestOf(goal.acceptance), criterionIds: ["M0-CODE-01"] }
  const assets = { bun: hash("bun"), verifier: hash("verifier"), wrapper: hash("wrapper"), supervisor: hash("supervisor") }
  const oldController = hash("old-controller"), currentController = hash("new-controller"), specDigest = hash("protected original spec"), manifestDigest = hash("original install manifest")
  const codePins = (controller: string) => ({ "bin/controller.mjs": controller, "bin/verifier.mjs": assets.verifier, "bin/worker-exec.py": assets.wrapper, "bin/worker-supervisor.py": assets.supervisor })
  const before = { root: DEPLOYMENT_JOB, keyId, manifestDigest, codeAssetDigests: codePins(oldController) }
  const current = { ...before, codeAssetDigests: codePins(currentController) }
  put("runReceipt", before); put("currentReceipt", current)
  const notBefore = "2026-10-09T10:00:00.000Z", observedAt = "2026-10-09T10:00:01.000Z", acceptedAt = "2026-10-09T10:00:02.000Z", deadlineAt = "2026-10-09T11:00:00.000Z"
  put("currentUpdate", { status: "applied-not-executed", finalRoot: DEPLOYMENT_JOB, previousSpecDigest: specDigest, specDigest,
    previousInstallReceiptDigest: byteDigest(raw.runReceipt), installReceiptDigest: byteDigest(raw.currentReceipt), codeAssetDigests: current.codeAssetDigests,
    replacements: [{ path: "bin/controller.mjs", oldDigest: oldController, newDigest: currentController }] })
  const pin = (role: DeploymentRole) => ({ path: `fixture://${role}`, digest: byteDigest(raw[role]) })
  put("runSpec", { schemaVersion: "m0-deployment-spec-summary/1", originDigest: specDigest, jobId: binding.taskId, runId: binding.runId, verifierKeyId: keyId,
    goal: pin("goal"), source: pin("source"), tests: pin("tests"), bun: { digest: assets.bun }, verifierCli: { digest: assets.verifier }, wrapper: { digest: assets.wrapper } })
  put("installManifest", { originDigest: manifestDigest, finalRoot: DEPLOYMENT_JOB, baselineCommit: goal.scope.baseRevision })
  put("runBudget", { deadlineAt, maxRepairs: 3, repairIndex: 2 })
  const candidateDigest = hash("actual candidate"), requestId = "request", evidenceRef = "file:///protected/evidence.json"
  const evidence = { schemaVersion: "fixture-verification-evidence/1", requestId, verifierId: "loopit-signer", binding, candidateDigest,
    testsDigest: byteDigest(raw.tests), compiledDigest: hash("compiled"), runtimeDigest: assets.bun, runnerDigest: byteDigest(raw.runner),
    startedAt: notBefore, finishedAt: observedAt, status: "passed", observations: Array.from({ length: 12 }, () => ({ matched: true, process: { code: 0, signal: null, timedOut: false, overflow: false } })),
    isolation: { signerUid: 421, network: "none", processFork: "denied", candidateEvaluatedInSigner: false, childContainsKey: false } }
  put("evidence", evidence)
  const ref = `${evidenceRef}#${byteDigest(raw.evidence)}`
  const gate = { schemaVersion: "gate/1", decisionId: "decision", scope: "delivery", goal: { taskId: "task", goalRevision: 1, acceptanceDigest: binding.acceptanceDigest },
    inputEvidenceDigests: [byteDigest(raw.evidence)], verifier: { id: "loopit-signer", version: "test", signatureRef: "file:///protected/signed.json" }, decidedAt: observedAt,
    results: [{ criterionId: "M0-CODE-01", outcome: "passed", evidenceRefs: [ref] }], uncovered: [], verdict: "passed" }
  const payload = { schemaVersion: "signed-fixture-check/1", verifierId: "loopit-signer", requestId, keyId, binding, candidateDigest, testsDigest: evidence.testsDigest,
    compiledDigest: evidence.compiledDigest, runtimeDigest: evidence.runtimeDigest, runnerDigest: evidence.runnerDigest,
    evidence: { ref, digest: byteDigest(raw.evidence) }, gate, result: "passed", testsPassed: 12, observedAt }
  put("signedCheck", { payload, signature: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64") })
  const proof = { scopeId: "scope", generation: 1, workerUid: 420, noLiveWorkerProcesses: true, userDomainAbsent: true,
    observations: Array.from({ length: 3 }, () => ({ processes: [], userDomainPresent: false })) }
  put("result", { status: "passed", scopeId: "scope", generation: 1, binding, candidateDigest, eventReplayMatches: true, milestonePassed: false,
    run: { runId: "run", status: "succeeded", history: [{ to: "succeeded", at: acceptedAt }] }, processStopProof: proof })
  put("execution", { scopeId: "scope", generation: 1, binding, dispatch: { runId: "run", createdAt: notBefore } })
  put("supervisorState", { phase: "stopped", scopeId: "scope", generation: 1, controllerDigest: oldController, specDigest, workerUid: 420, signerUid: 421,
    stopProof: { ...proof, observedUid: 420 }, signerStopProof: { ...proof, observedUid: 421 } })
  put("accountBoundaries", ["worker_cannot_read_controller_auth", "worker_cannot_write_controller_state", "worker_cannot_read_signing_key", "worker_cannot_write_protected_tests", "worker_can_write_candidate"]
    .map(name => ({ name, passed: true, status: name === "worker_can_write_candidate" ? 0 : 1, error: null, signal: null })))
  const trust: DeploymentTrust = { schemaVersion: "m0-verifier-deployment-trust/1", verifierId: "loopit-signer", keyId, jobRoot: DEPLOYMENT_JOB, binding,
    historical: { specDigest, receiptDigest: byteDigest(raw.runReceipt), manifestDigest, controllerDigest: oldController, notBefore, deadlineAt, acceptedAt },
    current: { specDigest, receiptDigest: byteDigest(raw.currentReceipt), controllerDigest: currentController, status: "applied-not-executed" }, assets, artifacts: [] }
  const files = DEPLOYMENT_ROLES.map(role => ({ role, path: `${role}.data` })), manifestPath = join(root, "manifest.json")
  const save = (repin = false) => {
    for (const file of files) writeFileSync(join(root, file.path), raw[file.role])
    writeFileSync(manifestPath, JSON.stringify({ schemaVersion: "m0-verifier-deployment-export/1", files }))
    if (repin) trust.artifacts = DEPLOYMENT_ROLES.map(role => ({ role, digest: byteDigest(raw[role]) }))
  }
  save(true)
  return { root, raw, put, save, files, manifestPath, trust, goal, json: (role: DeploymentRole) => JSON.parse(raw[role].toString()) }
}

test("a verified deployment only registers its exact historical Goal and Run, while current code remains unexecuted", () => {
  const f = fixture(), result = verifyDeploymentArchive(f.manifestPath, f.trust)
  expect(result.established).toBe(true)
  expect(result.current?.status).toBe("applied-not-executed")
  expect(result.historical?.controllerDigest).not.toBe(result.current?.controllerDigest)
  expect(deploymentScopeMatches(result, f.goal, "run")).toBe(true)
  expect(deploymentScopeMatches(result, f.goal, "other-run")).toBe(false)
  expect(deploymentScopeMatches(result, { ...f.goal, objective: "another task" }, "run")).toBe(false)
  // A test key and submitted trust object cannot reach the production loader.
  expect(readVerifierDeployment(f.manifestPath).established).toBe(false)
  if (process.getuid?.() !== 0) expect(() => deploymentBytes(f.manifestPath, 0)).toThrow("deployment_trust_unprotected")
})

test("missing, corrupted, duplicate, escaping and symbolic exported materials fail closed", () => {
  for (const mode of ["missing", "corrupt", "duplicate", "escape", "symlink"]) {
    const f = fixture(), path = join(f.root, "evidence.data")
    if (mode === "missing") rmSync(path)
    if (mode === "corrupt") writeFileSync(path, "changed")
    if (mode === "duplicate") { f.files[1]!.path = f.files[0]!.path; f.save() }
    if (mode === "escape") { f.files[1]!.path = "../outside"; writeFileSync(f.manifestPath, JSON.stringify({ schemaVersion: "m0-verifier-deployment-export/1", files: f.files })) }
    if (mode === "symlink") { rmSync(path); symlinkSync(join(f.root, "tests.data"), path) }
    expect(verifyDeploymentArchive(f.manifestPath, f.trust).established).toBe(false)
  }
})

test("repinning inconsistent root summaries cannot alias the new controller, new Run, missing DAC or expired acceptance into historical success", () => {
  for (const mode of ["controller", "run", "dac", "expired", "key", "signature"]) {
    const f = fixture()
    if (mode === "controller") f.trust.historical.controllerDigest = f.trust.current.controllerDigest
    if (mode === "run") f.trust.binding = { ...f.trust.binding, runId: "other-run" }
    if (mode === "dac") { const boundary = f.json("accountBoundaries"); boundary[2].status = 0; f.put("accountBoundaries", boundary) }
    if (mode === "expired") { f.trust.historical.acceptedAt = "2026-10-09T11:00:00.001Z"; const result = f.json("result"); result.run.history[0].at = f.trust.historical.acceptedAt; f.put("result", result) }
    if (mode === "key") f.trust.keyId = hash("wrong key")
    if (mode === "signature") { const signed = f.json("signedCheck"); signed.signature = "broken"; f.put("signedCheck", signed) }
    f.save(true)
    expect(verifyDeploymentArchive(f.manifestPath, f.trust).established).toBe(false)
  }
})

test("artifact reads obey exact binary length and refuse the configured size bound", () => {
  const f = fixture(), path = join(f.root, "bounded.bin"), bytes = Buffer.from([0, 255, 1, 128, 0])
  writeFileSync(path, bytes)
  expect(deploymentBytes(path, undefined, bytes.length)).toEqual(bytes)
  expect(() => deploymentBytes(path, undefined, bytes.length - 1)).toThrow("deployment_input_invalid")
  writeFileSync(path, Buffer.alloc(0))
  expect(deploymentBytes(path, undefined, 0)).toEqual(Buffer.alloc(0))
})
