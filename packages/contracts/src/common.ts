import { Schema } from "effect"

// Shared primitives for every persisted contract. `schemaVersion` values such as
// "goal/1" version the persisted shape only; they never track the app version.

export const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/))

export const Digest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/))

/** `scheme://path`, optionally pinned with `#sha256:<hex>`. */
export const Ref = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9+.-]*:\/\/[^\s#]+(#sha256:[0-9a-f]{64})?$/))

/** A ref that names immutable content: required before a goal may run. */
export const PinnedRef = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9+.-]*:\/\/[^\s#]+#sha256:[0-9a-f]{64}$/))

export const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/),
)

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export const NonEmptyString = Schema.String.check(Schema.isMinLength(1))

export const Stages = ["requirements", "design", "development", "verification", "release", "operations"] as const
export const Stage = Schema.Literals(Stages)
export type Stage = typeof Stage.Type
export const stageIndex = (stage: Stage) => Stages.indexOf(stage)

export const CapabilityStatus = Schema.Literals(["supported", "limited", "unsupported", "unverified"])
export type CapabilityStatus = typeof CapabilityStatus.Type

export const Verdict = Schema.Literals(["passed", "failed", "blocked"])
export type Verdict = typeof Verdict.Type

export const Actor = Schema.Struct({
  kind: Schema.Literals(["user", "worker", "verifier", "system"]),
  id: Id,
})
export type Actor = typeof Actor.Type

/** Unknown cost is explicit and never coerced to zero. */
export const Cost = Schema.Union([
  Schema.Struct({ known: Schema.Literal(true), usd: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)) }),
  Schema.Struct({ known: Schema.Literal(false), reason: NonEmptyString }),
])
export type Cost = typeof Cost.Type

export const Usage = Schema.Struct({
  cost: Cost,
  wallMs: NonNegativeInt,
  modelCalls: Schema.optionalKey(NonNegativeInt),
  toolCalls: Schema.optionalKey(NonNegativeInt),
  retries: Schema.optionalKey(NonNegativeInt),
  humanInterventions: NonNegativeInt,
})
export type Usage = typeof Usage.Type

export const Sensitivity = Schema.Literals(["public", "internal", "sensitive", "secret-derived"])
