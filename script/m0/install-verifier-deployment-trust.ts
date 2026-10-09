/** Fixed-job host snapshot. Default is read-only audit; --apply creates a new
 * public export and root trust index. No credentials/private key are read and
 * no model, account, device, process cleanup or prior report is changed. */
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createPublicKey } from "node:crypto"
import { canonicalJson } from "../../packages/contracts/src/digest"
import { acceptSignedFixtureCheck, byteDigest } from "../../packages/verifier/src/service"
import { DEPLOYMENT_EXPORT_ROOT, DEPLOYMENT_JOB, DEPLOYMENT_KEY_ID, DEPLOYMENT_ROLES, DEPLOYMENT_TRUST_PATH,
  deploymentBytes, deploymentMetadata, verifyDeploymentArchive, verifyDeploymentMaterials, type DeploymentRole, type DeploymentTrust } from "../../packages/verifier/src/deployment"

const revision = "signed-evidence-time-window-20261009i", control = join(DEPLOYMENT_JOB, "control")
const historical = join(control, "revisions", revision), signerRoot = "/private/var/loopit/signer/m0-verifier"
const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n")
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)
function requireValue(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(code) }
function sync(path: string) { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd) } finally { closeSync(fd) } }
function writeNew(path: string, bytes: Buffer) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444)
  try { fchmodSync(fd, 0o444); writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  sync(dirname(path))
}

export function collectFixedDeployment() {
  requireValue(process.platform === "darwin" && process.getuid?.() === 0 && process.geteuid?.() === 0, "root_macos_required")
  const originals = new Map<string, { uid: number; digest: string }>()
  const read = (path: string, uid = 0, limit = 16 * 1024 * 1024) => {
    const bytes = deploymentBytes(path, uid, limit)
    requireValue(lstatSync(path).uid === uid, "protected_file_owner_mismatch")
    originals.set(path, { uid, digest: byteDigest(bytes) }); return bytes
  }
  const raw = {} as Record<DeploymentRole, Buffer>
  const currentSpecBytes = read(join(control, "spec.json")), oldSpecBytes = read(join(historical, "spec.before.json"))
  const spec = JSON.parse(currentSpecBytes.toString()), oldSpec = JSON.parse(oldSpecBytes.toString())
  raw.runReceipt = read(join(historical, "install-receipt.before.json")); raw.currentReceipt = read(join(control, "install-receipt.json"))
  raw.currentUpdate = read(join(historical, "update-receipt.json"))
  const before = JSON.parse(raw.runReceipt.toString()), current = JSON.parse(raw.currentReceipt.toString()), update = JSON.parse(raw.currentUpdate.toString())
  const manifestBytes = read(join(control, "install-manifest.json")), manifest = JSON.parse(manifestBytes.toString())
  raw.runBudget = read(join(control, "execution-budget.json")); const budget = JSON.parse(raw.runBudget.toString())
  raw.supervisorState = read("/private/var/loopit/supervisor/active.json")
  const active = JSON.parse(raw.supervisorState.toString())
  requireValue(active.phase === "stopped" && active.controllerExitCode === 0 && active.finalizerExitCode === 0, "completed_supervisor_required")
  requireValue(spec.schemaVersion === "m0-control-loop/1" && spec.jobId === "m0-code-loop-20261009a" && spec.controlDirectory === control &&
    same(spec, oldSpec) && spec.verifierKeyId === DEPLOYMENT_KEY_ID && before.keyId === DEPLOYMENT_KEY_ID && current.keyId === DEPLOYMENT_KEY_ID,
    "fixed_spec_key_or_history_mismatch")
  requireValue(byteDigest(manifestBytes) === before.manifestDigest && before.manifestDigest === current.manifestDigest &&
    manifest.finalRoot === DEPLOYMENT_JOB && manifest.id === spec.jobId, "manifest_receipt_mismatch")
  requireValue(update.revisionId === revision && update.status === "applied-not-executed" && update.previousSpecDigest === byteDigest(oldSpecBytes) &&
    update.specDigest === byteDigest(currentSpecBytes) && update.previousInstallReceiptDigest === byteDigest(raw.runReceipt) &&
    update.installReceiptDigest === byteDigest(raw.currentReceipt), "update_receipt_mismatch")
  for (const role of ["goal", "source", "tests", "runner"] as const) {
    raw[role] = read(join(DEPLOYMENT_JOB, `public/${role === "source" ? "source.ts" : role === "runner" ? "runner.mjs" : `${role}.json`}`))
    requireValue(manifest.files.find((x: any) => x.path === `public/${role === "source" ? "source.ts" : role === "runner" ? "runner.mjs" : `${role}.json`}`)?.digest === byteDigest(raw[role]), "public_source_pin_mismatch")
    if (role !== "runner") requireValue(spec[role]?.digest === byteDigest(raw[role]) && spec[role]?.path === join(DEPLOYMENT_JOB, `public/${role === "source" ? "source.ts" : `${role}.json`}`), "spec_public_pin_mismatch")
  }
  raw.publicKey = read(join(control, "verifier-public.pem"))
  const publicKey = createPublicKey(raw.publicKey)
  requireValue(publicKey.asymmetricKeyType === "ed25519" && byteDigest(publicKey.export({ type: "spki", format: "der" })) === DEPLOYMENT_KEY_ID, "public_key_pin_mismatch")
  const assets = {} as DeploymentTrust["assets"]
  for (const [role, name] of [["bun", "bun"], ["verifier", "verifier.mjs"], ["wrapper", "worker-exec.py"], ["supervisor", "worker-supervisor.py"]] as const) {
    const bytes = read(join(DEPLOYMENT_JOB, "bin", name), 0, 256 * 1024 * 1024), digest = byteDigest(bytes)
    requireValue((name === "bun" ? spec.bun.digest : current.codeAssetDigests[`bin/${name}`]) === digest, "current_asset_pin_mismatch")
    if (name !== "bun") requireValue(before.codeAssetDigests[`bin/${name}`] === digest && byteDigest(read(join(historical, name))) === digest, "historical_asset_pin_mismatch")
    assets[role] = digest
  }
  const oldController = byteDigest(read(join(historical, "controller.mjs"))), currentController = byteDigest(read(join(DEPLOYMENT_JOB, "bin/controller.mjs")))
  requireValue(oldController === before.codeAssetDigests["bin/controller.mjs"] && currentController === current.codeAssetDigests["bin/controller.mjs"] &&
    oldController === active.controllerDigest && byteDigest(oldSpecBytes) === active.specDigest && oldController !== currentController, "controller_provenance_mismatch")
  raw.result = read(join(control, "reports/result.json")); const result = JSON.parse(raw.result.toString())
  raw.execution = read(join(control, "reports/execution.json")); const execution = JSON.parse(raw.execution.toString())
  requireValue(/^[a-zA-Z0-9-]+$/.test(result.scopeId) && result.scopeId === active.scopeId && result.generation === active.generation, "result_scope_mismatch")
  raw.accountBoundaries = read(join(control, `reports/account-boundaries-${result.scopeId}.json`))
  // Configuration is inspected internally; neither it nor its private-key path
  // is serialized. The private key and OAuth files are never opened.
  const configBytes = read(join(signerRoot, "config.json"), 421), config = JSON.parse(configBytes.toString())
  requireValue(byteDigest(configBytes) === spec.verifierConfigDigest && config.keyId === DEPLOYMENT_KEY_ID && config.signerUid === 421 &&
    config.builderUid === 420 && config.verifierId === "loopit-signer" && same(config.binding, result.binding), "signer_config_binding_mismatch")
  requireValue(config.privateKeyPath === join(signerRoot, "key.pem"), "private_key_location_invalid")
  const keyMetadata = deploymentMetadata(config.privateKeyPath, 421)
  requireValue((keyMetadata.mode & 0o777) === 0o600 && keyMetadata.isFile() && keyMetadata.nlink === 1, "private_key_custody_metadata_invalid")
  const response = JSON.parse(read(join(control, "reports/signed-check.json")).toString())
  requireValue(/^[a-zA-Z0-9-]+$/.test(response.payload?.requestId), "request_identity_invalid")
  const signerEvidence = join(signerRoot, "evidence", response.payload.requestId)
  raw.signedCheck = read(join(signerEvidence, "signed-check.json"), 421)
  raw.evidence = read(join(signerEvidence, "evidence.json"), 421)
  requireValue(same(JSON.parse(raw.signedCheck.toString()), response) && byteDigest(read(join(control, "reports/verification-evidence.json"))) === byteDigest(raw.evidence), "persisted_signer_evidence_mismatch")
  const acceptedAt = result.run.history.findLast((x: any) => x.to === "succeeded")?.at
  const accepted = acceptSignedFixtureCheck(response, raw.evidence, raw.publicKey.toString(), { binding: result.binding, candidateDigest: result.candidateDigest,
    keyId: DEPLOYMENT_KEY_ID, testsDigest: byteDigest(raw.tests) }, { notBefore: execution.dispatch.createdAt, deadlineAt: budget.deadlineAt, now: acceptedAt })
  requireValue(acceptedAt && accepted.accepted, "historical_signature_or_window_invalid")
  raw.runSpec = jsonBytes({ schemaVersion: "m0-deployment-spec-summary/1", originDigest: byteDigest(oldSpecBytes), jobId: oldSpec.jobId,
    runId: oldSpec.runId, verifierKeyId: oldSpec.verifierKeyId, goal: oldSpec.goal, source: oldSpec.source, tests: oldSpec.tests,
    bun: oldSpec.bun, verifierCli: oldSpec.verifierCli, wrapper: oldSpec.wrapper })
  raw.installManifest = jsonBytes({ schemaVersion: "m0-install-manifest-summary/1", originDigest: byteDigest(manifestBytes), id: manifest.id,
    finalRoot: manifest.finalRoot, baselineCommit: manifest.baselineCommit })
  const trust: DeploymentTrust = { schemaVersion: "m0-verifier-deployment-trust/1", verifierId: "loopit-signer", keyId: DEPLOYMENT_KEY_ID,
    jobRoot: DEPLOYMENT_JOB, binding: result.binding,
    historical: { specDigest: byteDigest(oldSpecBytes), receiptDigest: byteDigest(raw.runReceipt), manifestDigest: byteDigest(manifestBytes),
      controllerDigest: oldController, notBefore: execution.dispatch.createdAt, deadlineAt: budget.deadlineAt, acceptedAt },
    current: { specDigest: byteDigest(currentSpecBytes), receiptDigest: byteDigest(raw.currentReceipt), controllerDigest: currentController, status: "applied-not-executed" },
    assets, artifacts: DEPLOYMENT_ROLES.map(role => ({ role, digest: byteDigest(raw[role]) })) }
  const unchanged = () => { for (const [path, prior] of originals) requireValue(byteDigest(deploymentBytes(path, prior.uid, 256 * 1024 * 1024)) === prior.digest, "protected_input_changed") }
  unchanged()
  const verified = verifyDeploymentMaterials(trust, raw)
  requireValue(verified.established, verified.issues[0] ?? "deployment_material_validation_failed")
  return { raw, trust, unchanged }
}

async function main() {
  requireValue(process.argv.slice(2).every(x => x === "--apply") && process.argv.length <= 3, "only_apply_flag_supported")
  requireValue(!existsSync(DEPLOYMENT_TRUST_PATH) && !existsSync(DEPLOYMENT_EXPORT_ROOT), "existing_trust_or_export_refused")
  requireValue((deploymentMetadata(dirname(DEPLOYMENT_EXPORT_ROOT), 0).mode & 0o005) === 0o005, "public_export_parent_not_traversable")
  const material = collectFixedDeployment(), apply = process.argv.includes("--apply")
  if (!apply) { console.log(JSON.stringify({ status: "audited-not-installed", trust: material.trust, credentialsRead: false, privateKeyRead: false, modelCalls: 0 })); return }
  mkdirSync(DEPLOYMENT_EXPORT_ROOT, { mode: 0o755 }); chmodSync(DEPLOYMENT_EXPORT_ROOT, 0o755); sync(dirname(DEPLOYMENT_EXPORT_ROOT))
  const files = DEPLOYMENT_ROLES.map(role => ({ role, path: `${role}.${role === "publicKey" ? "pem" : role === "source" ? "ts" : role === "runner" ? "mjs" : "json"}` }))
  for (const file of files) writeNew(join(DEPLOYMENT_EXPORT_ROOT, file.path), material.raw[file.role])
  const manifestPath = join(DEPLOYMENT_EXPORT_ROOT, "manifest.json")
  writeNew(manifestPath, jsonBytes({ schemaVersion: "m0-verifier-deployment-export/1", files }))
  requireValue(verifyDeploymentArchive(manifestPath, material.trust).established, "export_validation_failed_no_trust_published")
  material.unchanged()
  writeNew(DEPLOYMENT_TRUST_PATH, jsonBytes(material.trust)) // publish last, exclusively
  console.log(JSON.stringify({ status: "installed-scoped-trust", trustPath: DEPLOYMENT_TRUST_PATH, trustDigest: byteDigest(readFileSync(DEPLOYMENT_TRUST_PATH)),
    manifestPath, historicalControllerDigest: material.trust.historical.controllerDigest, currentControllerDigest: material.trust.current.controllerDigest,
    currentStatus: "applied-not-executed", privateKeyRead: false, credentialsRead: false, modelCalls: 0, milestonePassed: false }))
}
if (import.meta.main) main().catch(error => { console.error(JSON.stringify({ status: "blocked", error: error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "fixed_deployment_snapshot_failed", noAutomaticRetry: true })); process.exitCode = 2 })
