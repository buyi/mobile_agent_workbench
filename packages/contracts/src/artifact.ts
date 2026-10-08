import { Schema } from "effect"
import { Digest, Id, NonEmptyString, NonNegativeInt, PositiveInt, Ref, Sensitivity, Timestamp } from "./common"
import { type ContractIssue, issue } from "./issue"
import type { GoalSpec } from "./goal"

// execution-contracts.md §2.1. Artifact = "an output exists"; Evidence = "how that
// output proves a criterion". Storage location may move; digest and identity do not.

export const ArtifactEnvelope = Schema.Struct({
  schemaVersion: Schema.Literal("artifact/1"),
  artifactId: Id,
  kind: Id,
  digest: Digest,
  size: NonNegativeInt,
  mediaType: NonEmptyString,
  storageRef: Ref,
  projectId: Id,
  taskId: Id,
  goalRevision: PositiveInt,
  runId: Id,
  stageRunId: Id,
  attemptId: Id,
  producer: Schema.Struct({ kind: Schema.Literals(["builder", "verifier", "build-agent", "device-broker", "release-agent"]), id: Id }),
  createdAt: Timestamp,
  inputDigests: Schema.Array(Digest),
  sensitivity: Sensitivity,
  retentionPolicy: Ref,
})
export type ArtifactEnvelope = typeof ArtifactEnvelope.Type

export const DeviceContext = Schema.Struct({
  platform: Schema.Literals(["android", "ios"]),
  deviceKind: Schema.Literals(["physical", "emulator", "simulator"]),
  deviceIdRef: Ref,
  os: NonEmptyString,
  installedBuildReceipt: Schema.Struct({ ref: Ref, buildDigest: Digest, bundleDigest: Schema.optionalKey(Digest) }),
  fixtureRef: Ref,
})

export const Evidence = Schema.Struct({
  schemaVersion: Schema.Literal("evidence/1"),
  evidenceId: Id,
  artifact: Schema.Struct({ artifactId: Id, digest: Digest }),
  issuer: Schema.Struct({ kind: Schema.Literals(["verifier", "build-agent", "device-broker", "release-agent", "builder"]), id: Id }),
  criterionIds: Schema.Array(Id).check(Schema.isMinLength(1)),
  goal: Schema.Struct({ taskId: Id, goalRevision: PositiveInt, acceptanceDigest: Digest }),
  candidateDigest: Digest,
  buildDigest: Schema.optionalKey(Digest),
  environmentRevision: NonEmptyString,
  toolVersion: NonEmptyString,
  observedAt: Timestamp,
  observationWindow: Schema.Struct({ start: Timestamp, end: Timestamp }),
  result: Schema.Literals(["passed", "failed", "inconclusive"]),
  limitations: Schema.Array(NonEmptyString),
  device: Schema.optionalKey(DeviceContext),
  revoked: Schema.optionalKey(Schema.Boolean),
})
export type Evidence = typeof Evidence.Type

export interface EvidenceBinding {
  readonly goal: GoalSpec
  readonly acceptanceDigest: string
  readonly candidateDigest: string
  readonly buildDigest?: string
  readonly now: string
  readonly validFor?: { readonly maxAgeMinutes: number }
}

/**
 * Whether evidence still proves its criteria for the current candidate/build/goal
 * (S08/S09/S19). Builder self-reports are auxiliary and never bind formally.
 */
export function checkEvidenceBinding(evidence: Evidence, binding: EvidenceBinding): ContractIssue[] {
  const issues: ContractIssue[] = []
  const at = (code: string, path: string, message: string) => issues.push(issue(code, path, message))
  if (evidence.revoked) at("evidence_revoked", "revoked", "Evidence was revoked")
  if (evidence.issuer.kind === "builder") at("evidence_untrusted_issuer", "issuer", "Builder output cannot be formal evidence")
  if (evidence.goal.taskId !== binding.goal.taskId || evidence.goal.goalRevision !== binding.goal.goalRevision)
    at("evidence_wrong_goal", "goal", "Evidence belongs to another goal revision")
  if (evidence.goal.acceptanceDigest !== binding.acceptanceDigest)
    at("evidence_wrong_acceptance", "goal.acceptanceDigest", "Acceptance contract changed since evidence was collected")
  if (evidence.candidateDigest !== binding.candidateDigest)
    at("evidence_stale_candidate", "candidateDigest", "Evidence was collected on another candidate")
  if (binding.buildDigest !== undefined && evidence.buildDigest !== binding.buildDigest)
    at("evidence_stale_build", "buildDigest", "Evidence was collected on another build")
  if (evidence.device && evidence.buildDigest && evidence.device.installedBuildReceipt.buildDigest !== evidence.buildDigest)
    at("evidence_install_mismatch", "device.installedBuildReceipt", "Installed build differs from the evidence build")
  if (Date.parse(evidence.observationWindow.end) < Date.parse(evidence.observationWindow.start))
    at("evidence_window_invalid", "observationWindow", "Window ends before it starts")
  if (binding.validFor) {
    const age = (Date.parse(binding.now) - Date.parse(evidence.observedAt)) / 60_000
    if (age > binding.validFor.maxAgeMinutes) at("evidence_expired", "observedAt", `Evidence is ${Math.round(age)}m old`)
  }

  const criteria = new Map(binding.goal.acceptance.map((item) => [item.id, item]))
  for (const id of evidence.criterionIds) {
    const criterion = criteria.get(id)
    if (!criterion) {
      at("evidence_unknown_criterion", "criterionIds", `Unknown criterion ${id}`)
      continue
    }
    const targets = binding.goal.targetMatrix.filter((t) => !criterion.platforms || criterion.platforms.includes(t.platform))
    const deviceKinds = criterion.evidenceKinds.some((kind) => kind.startsWith("ui-") || kind.includes("install"))
    if (deviceKinds && targets.length > 0) {
      if (!evidence.device) at("evidence_device_missing", "device", `${id} requires device evidence`)
      else if (!targets.some((t) => t.platform === evidence.device!.platform && t.deviceKind === evidence.device!.deviceKind))
        at(
          "evidence_device_mismatch",
          "device",
          `${evidence.device.platform}/${evidence.device.deviceKind} does not satisfy ${targets.map((t) => `${t.platform}/${t.deviceKind}`).join(", ")}`,
        )
    }
  }
  return issues
}
