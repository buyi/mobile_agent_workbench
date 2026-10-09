import { createPublicKey } from "node:crypto"
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { canonicalJson, digestOf } from "../../contracts/src/digest"
import { parse } from "../../contracts/src/registry"
import { acceptSignedFixtureCheck, byteDigest, type Binding } from "./service"

export const DEPLOYMENT_TRUST_PATH = "/private/var/loopit/verifier-deployment-trust.json"
export const DEPLOYMENT_EXPORT_ROOT = "/private/var/loopit/verifier-deployment-export"
export const DEPLOYMENT_JOB = "/private/var/loopit/m0-runs/m0-code-loop-20261009a"
export const DEPLOYMENT_KEY_ID = "sha256:6c14767c3ec318cc893dee4ebed30231bf2b612ff276f7e59c1a3a00234cb7aa"
export const DEPLOYMENT_ROLES = ["publicKey", "goal", "source", "tests", "runner", "signedCheck", "evidence", "result", "execution",
  "accountBoundaries", "runReceipt", "currentReceipt", "currentUpdate", "installManifest", "runSpec", "runBudget", "supervisorState"] as const
export type DeploymentRole = typeof DEPLOYMENT_ROLES[number]
export type DeploymentTrust = {
  schemaVersion: "m0-verifier-deployment-trust/1"; verifierId: "loopit-signer"; keyId: string; jobRoot: string; binding: Binding
  historical: { specDigest: string; receiptDigest: string; manifestDigest: string; controllerDigest: string;
    notBefore: string; deadlineAt: string; acceptedAt: string }
  current: { specDigest: string; receiptDigest: string; controllerDigest: string; status: "applied-not-executed" }
  assets: { bun: string; verifier: string; wrapper: string; supervisor: string }
  artifacts: Array<{ role: DeploymentRole; digest: string }>
}
export type DeploymentRegistration = { established: boolean; issues: string[]; trustDigest?: string;
  verifier?: { id: string; keyId: string; publicKeyPem: string; binding: Binding }; historical?: DeploymentTrust["historical"];
  current?: DeploymentTrust["current"]; checkedArtifacts?: Array<{ role: string; digest: string }> }
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)
const sha = (value: unknown) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)
const exact = (value: unknown, fields: readonly string[]) => !!value && typeof value === "object" && !Array.isArray(value) && same(Object.keys(value).sort(), [...fields].sort())

/** Metadata only; suitable for key custody checks without opening key bytes. */
export function deploymentMetadata(path: string, protectedUid: number) {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) throw new Error("deployment_path_noncanonical")
  const initial = lstatSync(path)
  if (initial.uid !== protectedUid) throw new Error("deployment_trust_unprotected")
  for (let part = path; ; part = dirname(part)) {
    const stat = lstatSync(part)
    if (stat.isSymbolicLink() || ![0, protectedUid].includes(stat.uid) || (stat.mode & 0o022)) throw new Error("deployment_trust_unprotected")
    if (process.platform === "darwin") {
      const acl = spawnSync("/bin/ls", ["-lde", part], { encoding: "utf8", timeout: 3000, maxBuffer: 65536, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } })
      if (acl.error || acl.status !== 0 || acl.signal || acl.stdout.trim().split("\n").length !== 1 || acl.stdout.split(/\s/)[0]?.includes("+"))
        throw new Error("deployment_extended_acl_unverified")
    }
    if (part === "/") break
  }
  return initial
}

/** No symlink, FIFO, hardlink, oversized or concurrently changing inputs. Root
 * ownership is mandatory only for the independent host trust index. */
export function deploymentBytes(path: string, protectedUid?: number, limit = 16 * 1024 * 1024) {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) throw new Error("deployment_path_noncanonical")
  const initial = protectedUid === undefined ? lstatSync(path) : deploymentMetadata(path, protectedUid)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.size > limit || before.ino !== initial.ino || before.dev !== initial.dev ||
        before.uid !== initial.uid || before.mode !== initial.mode || protectedUid !== undefined && (before.uid !== protectedUid || (before.mode & 0o022)))
      throw new Error("deployment_input_invalid")
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new Error("deployment_input_changed")
      offset += count
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0) throw new Error("deployment_input_changed")
    const after = fstatSync(fd)
    const pathAfter = lstatSync(path)
    if (before.size !== bytes.length || before.size !== after.size || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs ||
        before.uid !== after.uid || before.gid !== after.gid || before.mode !== after.mode || before.nlink !== after.nlink ||
        before.ino !== pathAfter.ino || before.dev !== pathAfter.dev || before.uid !== pathAfter.uid || before.mode !== pathAfter.mode)
      throw new Error("deployment_input_changed")
    return bytes
  } finally { closeSync(fd) }
}

/** Pure conformance seam. It DOES NOT establish that a caller-supplied trust
 * object is independent. Production must use readVerifierDeployment below. */
export function verifyDeploymentArchive(manifestPath: string, trust: DeploymentTrust): DeploymentRegistration {
  try {
    if (!exact(trust, ["schemaVersion", "verifierId", "keyId", "jobRoot", "binding", "historical", "current", "assets", "artifacts"]) ||
        trust.schemaVersion !== "m0-verifier-deployment-trust/1" || trust.verifierId !== "loopit-signer" || !sha(trust.keyId) ||
        trust.jobRoot !== DEPLOYMENT_JOB || !exact(trust.historical, ["specDigest", "receiptDigest", "manifestDigest", "controllerDigest", "notBefore", "deadlineAt", "acceptedAt"]) ||
        !exact(trust.current, ["specDigest", "receiptDigest", "controllerDigest", "status"]) || trust.current.status !== "applied-not-executed" ||
        !exact(trust.assets, ["bun", "verifier", "wrapper", "supervisor"]) || Object.values(trust.assets).some(x => !sha(x)) ||
        [trust.historical.specDigest, trust.historical.receiptDigest, trust.historical.manifestDigest, trust.historical.controllerDigest,
          trust.current.specDigest, trust.current.receiptDigest, trust.current.controllerDigest].some(x => !sha(x)) ||
        !Array.isArray(trust.artifacts) || trust.artifacts.length !== DEPLOYMENT_ROLES.length ||
        !same(trust.artifacts.map(x => x.role).sort(), [...DEPLOYMENT_ROLES].sort()) || trust.artifacts.some(x => !exact(x, ["role", "digest"]) || !sha(x.digest)))
      throw new Error("deployment_trust_schema_invalid")
    const manifest = JSON.parse(deploymentBytes(manifestPath).toString())
    if (!exact(manifest, ["schemaVersion", "files"]) || manifest.schemaVersion !== "m0-verifier-deployment-export/1" ||
        !Array.isArray(manifest.files) || !same(manifest.files.map((x: any) => x.role).sort(), [...DEPLOYMENT_ROLES].sort()))
      throw new Error("deployment_manifest_invalid")
    const root = dirname(manifestPath), raw = {} as Record<DeploymentRole, Buffer>, seen = new Set<string>()
    for (const file of manifest.files) {
      if (!exact(file, ["role", "path"]) || typeof file.path !== "string" || isAbsolute(file.path) || file.path.includes("\\") || file.path.includes("\0") || file.path.split("/").includes(".."))
        throw new Error("deployment_artifact_path_invalid")
      const path = resolve(root, file.path), rel = relative(root, path)
      if (!rel || rel.startsWith("../") || seen.has(path)) throw new Error("deployment_artifact_duplicate_or_escape")
      seen.add(path)
      const content = deploymentBytes(path), role = file.role as DeploymentRole
      if (byteDigest(content) !== trust.artifacts.find(x => x.role === role)?.digest) throw new Error("deployment_artifact_digest_mismatch")
      raw[role] = content
    }
    return verifyDeploymentMaterials(trust, raw)
  } catch (error) { return { established: false, issues: [error instanceof Error && error.message.startsWith("deployment_") ? error.message : "deployment_input_invalid"] } }
}

/** Pure material verification for the root collector before it writes exports. */
export function verifyDeploymentMaterials(trust: DeploymentTrust, raw: Record<DeploymentRole, Buffer>): DeploymentRegistration {
  try {
    const data = (role: DeploymentRole) => JSON.parse(raw[role].toString())
    const pem = raw.publicKey.toString(), publicKey = createPublicKey(pem)
    if (publicKey.asymmetricKeyType !== "ed25519" || byteDigest(publicKey.export({ type: "spki", format: "der" })) !== trust.keyId)
      throw new Error("deployment_public_key_mismatch")
    const goal = parse("goal", data("goal")), result = data("result"), execution = data("execution"), signed = data("signedCheck"), evidence = data("evidence")
    const spec = data("runSpec"), manifestSummary = data("installManifest"), before = data("runReceipt"), current = data("currentReceipt"), update = data("currentUpdate"), budget = data("runBudget")
    if (!goal.ok || goal.value.taskId !== trust.binding.taskId || goal.value.projectId !== trust.binding.projectId || goal.value.goalRevision !== trust.binding.goalRevision ||
        digestOf(goal.value) !== trust.binding.goalDigest || digestOf(goal.value.acceptance) !== trust.binding.acceptanceDigest ||
        byteDigest(raw.source) !== trust.binding.sourceDigest || goal.value.scope.baseRevision !== manifestSummary.baselineCommit ||
        goal.value.targetMatrix.length !== 0 || !same(goal.value.acceptance.map(x => x.id), ["M0-CODE-01"])) throw new Error("deployment_goal_binding_invalid")
    if (spec.schemaVersion !== "m0-deployment-spec-summary/1" || spec.originDigest !== trust.historical.specDigest || spec.jobId !== trust.binding.taskId || spec.runId !== trust.binding.runId ||
        spec.verifierKeyId !== trust.keyId || spec.goal.digest !== byteDigest(raw.goal) || spec.source.digest !== byteDigest(raw.source) || spec.tests.digest !== byteDigest(raw.tests) ||
        spec.bun.digest !== trust.assets.bun || spec.verifierCli.digest !== trust.assets.verifier || spec.wrapper.digest !== trust.assets.wrapper ||
        manifestSummary.originDigest !== trust.historical.manifestDigest || manifestSummary.finalRoot !== trust.jobRoot ||
        before.root !== trust.jobRoot || current.root !== trust.jobRoot || before.manifestDigest !== trust.historical.manifestDigest || current.manifestDigest !== trust.historical.manifestDigest ||
        byteDigest(raw.runReceipt) !== trust.historical.receiptDigest || byteDigest(raw.currentReceipt) !== trust.current.receiptDigest ||
        before.keyId !== trust.keyId || current.keyId !== trust.keyId) throw new Error("deployment_install_binding_invalid")
    const code = (receipt: any, controller: string) => receipt.codeAssetDigests?.["bin/controller.mjs"] === controller &&
      receipt.codeAssetDigests?.["bin/verifier.mjs"] === trust.assets.verifier && receipt.codeAssetDigests?.["bin/worker-exec.py"] === trust.assets.wrapper &&
      receipt.codeAssetDigests?.["bin/worker-supervisor.py"] === trust.assets.supervisor
    if (!code(before, trust.historical.controllerDigest) || !code(current, trust.current.controllerDigest) ||
        update.status !== "applied-not-executed" || update.finalRoot !== trust.jobRoot || update.previousSpecDigest !== trust.historical.specDigest ||
        update.specDigest !== trust.current.specDigest || update.previousInstallReceiptDigest !== trust.historical.receiptDigest ||
        update.installReceiptDigest !== trust.current.receiptDigest || !same(update.codeAssetDigests, current.codeAssetDigests) ||
        !update.replacements?.some((x: any) => x.path === "bin/controller.mjs" && x.oldDigest === trust.historical.controllerDigest && x.newDigest === trust.current.controllerDigest))
      throw new Error("deployment_code_history_invalid")
    const accepted = result.run?.history?.findLast((x: any) => x.to === "succeeded")?.at
    if (result.status !== "passed" || result.run.status !== "succeeded" || result.run.runId !== trust.binding.runId ||
        !same(result.binding, trust.binding) || !same(execution.binding, trust.binding) || execution.dispatch.runId !== trust.binding.runId ||
        execution.dispatch.createdAt !== trust.historical.notBefore || accepted !== trust.historical.acceptedAt || budget.deadlineAt !== trust.historical.deadlineAt ||
        result.scopeId !== execution.scopeId || result.generation !== execution.generation || !result.eventReplayMatches || result.milestonePassed !== false ||
        budget.maxRepairs !== 3 || budget.repairIndex > 3) throw new Error("deployment_run_binding_invalid")
    const acceptedCheck = acceptSignedFixtureCheck(signed, raw.evidence, pem, { binding: trust.binding, candidateDigest: result.candidateDigest,
      keyId: trust.keyId, testsDigest: byteDigest(raw.tests) }, { notBefore: trust.historical.notBefore, deadlineAt: trust.historical.deadlineAt, now: trust.historical.acceptedAt })
    if (!acceptedCheck.accepted) throw new Error(`deployment_attestation_${acceptedCheck.reason}`)
    if (evidence.isolation?.signerUid !== 421 || evidence.isolation?.network !== "none" || evidence.isolation?.processFork !== "denied" ||
        evidence.isolation?.candidateEvaluatedInSigner !== false || evidence.isolation?.childContainsKey !== false ||
        evidence.runtimeDigest !== trust.assets.bun || evidence.runnerDigest !== byteDigest(raw.runner)) throw new Error("deployment_signer_boundary_invalid")
    const boundary = data("accountBoundaries"), required = ["worker_cannot_read_controller_auth", "worker_cannot_write_controller_state", "worker_cannot_read_signing_key", "worker_cannot_write_protected_tests", "worker_can_write_candidate"]
    if (!Array.isArray(boundary) || !same(boundary.map((x: any) => x.name).sort(), required.sort()) || boundary.some((x: any) =>
      x.passed !== true || x.error !== null || x.signal !== null || x.status !== (x.name === "worker_can_write_candidate" ? 0 : 1))) throw new Error("deployment_dac_negative_missing")
    const supervisor = data("supervisorState"), stop = result.processStopProof
    const stopped = (proof: any, uid: number) => proof?.scopeId === result.scopeId && proof.generation === result.generation &&
      proof.observedUid === uid && proof.noLiveWorkerProcesses === true && proof.userDomainAbsent === true &&
      proof.observations?.length >= 3 && proof.observations.every((x: any) => x.processes?.length === 0 && x.userDomainPresent === false)
    if (supervisor.phase !== "stopped" || supervisor.scopeId !== result.scopeId || supervisor.generation !== result.generation ||
        supervisor.controllerDigest !== trust.historical.controllerDigest || supervisor.specDigest !== trust.historical.specDigest || supervisor.workerUid !== 420 || supervisor.signerUid !== 421 ||
        !stopped(supervisor.stopProof, 420) || !stopped(supervisor.signerStopProof, 421) ||
        stop.scopeId !== result.scopeId || stop.generation !== result.generation || stop.workerUid !== 420 || !stop.noLiveWorkerProcesses || !stop.userDomainAbsent ||
        stop.observations?.length < 3 || stop.observations.some((x: any) => x.processes?.length !== 0 || x.userDomainPresent !== false))
      throw new Error("deployment_supervisor_binding_invalid")
    return { established: true, issues: [], verifier: { id: trust.verifierId, keyId: trust.keyId, publicKeyPem: pem, binding: trust.binding },
      historical: trust.historical, current: trust.current, checkedArtifacts: trust.artifacts }
  } catch (error) { return { established: false, issues: [error instanceof Error && error.message.startsWith("deployment_") ? error.message : "deployment_input_invalid"] } }
}

/** Sole production entry: caller controls evidence location but cannot select a
 * trust file, public key, scope, or an independence boolean. */
export function readVerifierDeployment(manifestPath: string): DeploymentRegistration {
  try {
    const bytes = deploymentBytes(DEPLOYMENT_TRUST_PATH, 0), trust = JSON.parse(bytes.toString()) as DeploymentTrust
    if (trust.keyId !== DEPLOYMENT_KEY_ID) throw new Error("deployment_root_key_mismatch")
    return { ...verifyDeploymentArchive(resolve(manifestPath), trust), trustDigest: byteDigest(bytes) }
  } catch { return { established: false, issues: ["deployment_root_trust_missing_or_unprotected"] } }
}

export function deploymentScopeMatches(registration: DeploymentRegistration, goal: unknown, runId: string | undefined) {
  const parsed = parse("goal", goal), binding = registration.verifier?.binding
  return registration.established && !!binding && parsed.ok && runId === binding.runId && parsed.value.taskId === binding.taskId &&
    parsed.value.projectId === binding.projectId && parsed.value.goalRevision === binding.goalRevision && digestOf(parsed.value) === binding.goalDigest &&
    digestOf(parsed.value.acceptance) === binding.acceptanceDigest
}
