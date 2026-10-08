import { Schema } from "effect"
import { Digest, Id, NonEmptyString, PositiveInt, Ref } from "./common"

// An immutable project policy version (main spec §1.1): every autonomous action
// is allowed or denied against it, instead of per-step human approval.

export const SideEffectClass = Schema.Literals(["read_only", "idempotent_write", "reconcile_required", "irreversible"])
export type SideEffectClass = typeof SideEffectClass.Type

export const PolicyRef = Schema.Struct({
  schemaVersion: Schema.Literal("policy/1"),
  policyId: Id,
  version: PositiveInt,
  digest: Digest,
  permissions: Schema.Struct({
    writablePaths: Schema.Array(NonEmptyString),
    network: Schema.Literals(["none", "allowlist", "open"]),
    networkAllowlist: Schema.optionalKey(Schema.Array(NonEmptyString)),
    maxSideEffect: SideEffectClass,
  }),
  tools: Schema.Array(Schema.Struct({ toolId: Id, version: NonEmptyString })),
  data: Schema.Struct({
    allowedSensitivity: Schema.Array(Schema.Literals(["public", "internal", "sensitive"])),
    retentionPolicyRef: Ref,
  }),
  deployment: Schema.Struct({
    environments: Schema.Array(Ref),
    channels: Schema.Array(Ref),
    autoMerge: Schema.Boolean,
  }),
  resources: Schema.Struct({
    devices: Schema.Array(Ref),
    workers: Schema.Array(Ref),
    secrets: Schema.Array(Ref),
  }),
  failure: Schema.Struct({
    maxTransientAttempts: PositiveInt,
    maxRepairCycles: PositiveInt,
  }),
})
export type PolicyRef = typeof PolicyRef.Type
