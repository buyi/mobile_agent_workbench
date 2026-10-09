import { Schema } from "effect"
import {
  Digest,
  Id,
  NonEmptyString,
  NonNegativeInt,
  PinnedRef,
  PositiveInt,
  Ref,
  Stage,
  stageIndex,
} from "./common"
import { type ContractIssue, duplicates, findCycle, issue } from "./issue"

// execution-contracts.md §1. A GoalRevision is immutable; only the user's goal or
// acceptance change produces a new revision.

export const Verification = Schema.Literals(["executable", "measured", "semantic"])

export const AcceptanceCriterion = Schema.Struct({
  id: Id,
  expected: NonEmptyString,
  verification: Verification,
  evidenceKinds: Schema.Array(Id).check(Schema.isMinLength(1)),
  requiredAtStage: Stage,
  dependsOn: Schema.optionalKey(Schema.Array(Id)),
  platforms: Schema.optionalKey(Schema.Array(Id)),
  threshold: Schema.optionalKey(
    Schema.Struct({ metric: Id, comparator: Schema.Literals(["<=", ">=", "<", ">", "=="]), value: Schema.Finite }),
  ),
  rubricRef: Schema.optionalKey(Ref),
})
export type AcceptanceCriterion = typeof AcceptanceCriterion.Type

export const TargetDevice = Schema.Struct({
  platform: Schema.Literals(["android", "ios"]),
  deviceKind: Schema.Literals(["physical", "emulator", "simulator"]),
  deviceRef: Schema.optionalKey(Ref),
  os: Schema.optionalKey(NonEmptyString),
})

export const GoalSpec = Schema.Struct({
  schemaVersion: Schema.Literal("goal/1"),
  projectId: Id,
  taskId: Id,
  goalRevision: PositiveInt,
  objective: NonEmptyString,
  scope: Schema.Struct({
    repositoryRef: Ref,
    baseRevision: NonEmptyString,
    allowedPaths: Schema.Array(NonEmptyString),
    inputRefs: Schema.optionalKey(Schema.Array(Ref)),
    excluded: Schema.Array(NonEmptyString),
  }),
  acceptance: Schema.Array(AcceptanceCriterion).check(Schema.isMinLength(1)),
  targetMatrix: Schema.Array(TargetDevice),
  delivery: Schema.Struct({
    artifactKinds: Schema.optionalKey(Schema.Array(Id)),
    channelRef: Schema.optionalKey(Ref),
    environmentRef: Schema.optionalKey(Ref),
    merge: Schema.optionalKey(Schema.Boolean),
    observation: Schema.optionalKey(
      Schema.Struct({ minutes: PositiveInt, minHealthProbes: NonNegativeInt, minPathRuns: NonNegativeInt }),
    ),
  }),
  policyRef: Ref,
  budgets: Schema.Struct({
    wallMinutes: PositiveInt,
    maxRepairCycles: NonNegativeInt,
    maxParallelWriters: PositiveInt,
  }),
  costBudgetRef: Ref,
  resources: Schema.optionalKey(
    Schema.Struct({
      workerCapabilities: Schema.optionalKey(Schema.Array(Id)),
      fixtureRefs: Schema.optionalKey(Schema.Array(Ref)),
      secretRefs: Schema.optionalKey(Schema.Array(Ref)),
    }),
  ),
  supersedes: Schema.optionalKey(Schema.Struct({ goalRevision: PositiveInt, digest: Digest })),
})
export type GoalSpec = typeof GoalSpec.Type

/** Cross-field rules that a struct schema cannot express. */
export function validateGoal(goal: GoalSpec): ContractIssue[] {
  const issues: ContractIssue[] = []
  const byId = new Map(goal.acceptance.map((item) => [item.id, item]))
  for (const id of duplicates(goal.acceptance.map((item) => item.id)))
    issues.push(issue("acceptance_duplicate_id", `acceptance.${id}`, `Duplicate acceptance id ${id}`))

  goal.acceptance.forEach((item, index) => {
    const path = `acceptance[${index}]`
    if (item.verification === "semantic" && !item.rubricRef)
      issues.push(issue("acceptance_rubric_missing", path, "Semantic criteria require a fixed rubricRef"))
    if (item.verification === "measured" && !item.threshold)
      issues.push(issue("acceptance_threshold_missing", path, "Measured criteria require a threshold"))
    for (const dep of item.dependsOn ?? []) {
      const target = byId.get(dep)
      if (!target) {
        issues.push(issue("acceptance_dependency_unknown", `${path}.dependsOn`, `Unknown criterion ${dep}`))
        continue
      }
      if (stageIndex(target.requiredAtStage) > stageIndex(item.requiredAtStage))
        issues.push(
          issue(
            "acceptance_dependency_future_stage",
            `${path}.dependsOn`,
            `${item.id}@${item.requiredAtStage} depends on ${dep}@${target.requiredAtStage}, which is only produced later`,
          ),
        )
    }
  })

  const cycle = findCycle(byId.keys(), (id) => byId.get(id)?.dependsOn ?? [])
  if (cycle) issues.push(issue("acceptance_dependency_cycle", "acceptance", `Cycle: ${cycle.join(" -> ")}`))
  return issues
}

const PLACEHOLDER = /<[^<>]+>/
const COMMIT = /^[0-9a-f]{40}$/

/**
 * A goal may enter a delivery Run only when every input resolves to an exact
 * version (M0-F13, M1 entry). Draft goals may still be stored and investigated.
 */
export function checkFrozen(goal: GoalSpec): ContractIssue[] {
  const issues: ContractIssue[] = []
  const scan = (value: unknown, path: string) => {
    if (typeof value === "string") {
      if (PLACEHOLDER.test(value)) issues.push(issue("placeholder", path, `Unresolved placeholder in ${value}`))
      return
    }
    if (Array.isArray(value)) return value.forEach((item, index) => scan(item, `${path}[${index}]`))
    if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) scan(item, path ? `${path}.${key}` : key)
  }
  scan(goal, "")

  if (!COMMIT.test(goal.scope.baseRevision))
    issues.push(issue("unpinned", "scope.baseRevision", "Base revision must be a full commit hash"))
  if (goal.scope.allowedPaths.length === 0)
    issues.push(issue("scope_empty", "scope.allowedPaths", "At least one allowed path is required"))
  const pinned = Schema.is(PinnedRef)
  const refs: Array<[string, string | undefined]> = [
    ["policyRef", goal.policyRef],
    ["costBudgetRef", goal.costBudgetRef],
    ["delivery.channelRef", goal.delivery.channelRef],
    ["delivery.environmentRef", goal.delivery.environmentRef],
  ]
  for (const [path, ref] of refs)
    if (ref !== undefined && !pinned(ref)) issues.push(issue("unpinned", path, `${ref} must be pinned with #sha256`))
  goal.resources?.fixtureRefs?.forEach((ref, index) => {
    if (!pinned(ref)) issues.push(issue("unpinned", `resources.fixtureRefs[${index}]`, `${ref} must be pinned`))
  })
  goal.acceptance.forEach((criterion, index) => {
    if (criterion.rubricRef && !pinned(criterion.rubricRef))
      issues.push(issue("unpinned", `acceptance[${index}].rubricRef`, "The acceptance rubric must be pinned"))
  })
  goal.targetMatrix.forEach((target, index) => {
    if (!target.deviceRef)
      issues.push(issue("device_identity_missing", `targetMatrix[${index}].deviceRef`, "A declared target must identify its registered device"))
    else if (!pinned(target.deviceRef))
      issues.push(issue("unpinned", `targetMatrix[${index}].deviceRef`, "The device descriptor must be pinned"))
    if (!target.os)
      issues.push(issue("device_os_missing", `targetMatrix[${index}].os`, "A declared target must freeze its operating system version"))
  })
  return issues
}
