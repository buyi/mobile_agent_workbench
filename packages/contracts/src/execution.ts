import { Schema } from "effect"
import { CapabilityStatus, Digest, Id, NonEmptyString, NonNegativeInt, PositiveInt, Ref, Timestamp } from "./common"

// main spec §5.2 and execution-contracts.md §5.

export const ContextManifest = Schema.Struct({
  schemaVersion: Schema.Literal("context/1"),
  manifestId: Id,
  attemptId: Id,
  createdAt: Timestamp,
  goal: Schema.Struct({ taskId: Id, goalRevision: PositiveInt, digest: Digest }),
  candidate: Schema.optionalKey(Schema.Struct({ ref: Ref, digest: Digest })),
  plan: Schema.optionalKey(Schema.Struct({ version: PositiveInt, digest: Digest })),
  policy: Schema.Struct({ ref: Ref, digest: Digest }),
  toolCapabilities: Schema.Array(Schema.Struct({ toolId: Id, version: NonEmptyString })),
  // Effective instructions, skills and permission config. Nothing outside this
  // list may enter the runner (no implicit global personal config).
  effectiveConfig: Schema.Array(
    Schema.Struct({ kind: Schema.Literals(["instruction", "skill", "permission", "model"]), ref: Ref, digest: Digest }),
  ),
  knowledgeRefs: Schema.Array(Schema.Struct({ ref: Ref, digest: Digest })),
  historyRefs: Schema.Array(Schema.Struct({ ref: Ref, digest: Digest })),
  budget: Schema.Struct({ wallMinutesRemaining: NonNegativeInt, repairCyclesRemaining: NonNegativeInt }),
  // Additions during execution are appended as versioned refs; the base is immutable.
  appended: Schema.optionalKey(Schema.Array(Schema.Struct({ seq: PositiveInt, ref: Ref, digest: Digest }))),
})
export type ContextManifest = typeof ContextManifest.Type

export const ExecutionSpec = Schema.Struct({
  schemaVersion: Schema.Literal("execution/1"),
  executionId: Id,
  attemptId: Id,
  runtime: Schema.Struct({ name: Id, version: NonEmptyString, sourceDigest: Schema.optionalKey(Digest) }),
  model: Schema.Struct({ provider: Id, model: NonEmptyString }),
  nativeSessionRef: Schema.optionalKey(Ref),
  workingDirectory: NonEmptyString,
  contextManifest: Schema.Struct({ ref: Ref, digest: Digest }),
  policyRef: Ref,
  budget: Schema.Struct({ wallMinutes: PositiveInt, maxRetries: NonNegativeInt }),
  outputContract: Schema.Struct({ artifactKinds: Schema.Array(Id) }),
})
export type ExecutionSpec = typeof ExecutionSpec.Type

const Capability = Schema.Struct({
  status: CapabilityStatus,
  evidenceRef: Schema.optionalKey(Ref),
  note: Schema.optionalKey(NonEmptyString),
})

export const RuntimeCapabilities = Schema.Struct({
  schemaVersion: Schema.Literal("runtime-capabilities/1"),
  runtime: Schema.Struct({ name: Id, version: NonEmptyString }),
  probedAt: Timestamp,
  structuredEvents: Capability,
  images: Capability,
  toolsMcp: Capability,
  nativeResume: Capability,
  checkpoint: Capability,
  steer: Capability,
  cancelMode: Schema.Struct({
    status: CapabilityStatus,
    mode: Schema.Literals(["turn", "process", "process-tree", "none"]),
    evidenceRef: Schema.optionalKey(Ref),
  }),
  processTreeControl: Capability,
  permissionModes: Schema.Array(Id),
  sandboxKinds: Schema.Array(Id),
  usageReporting: Capability,
  maxConcurrency: NonNegativeInt,
})
export type RuntimeCapabilities = typeof RuntimeCapabilities.Type

/** Capabilities the autonomous set may rely on: only measured `supported`. */
export function autonomousGaps(caps: RuntimeCapabilities): string[] {
  const required = ["structuredEvents", "processTreeControl", "usageReporting"] as const
  const gaps: string[] = required.filter((key) => caps[key].status !== "supported" || !caps[key].evidenceRef)
  if (caps.cancelMode.status !== "supported" || caps.cancelMode.mode === "none") gaps.push("cancelMode")
  if (caps.sandboxKinds.length === 0) gaps.push("sandboxKinds")
  return gaps
}
