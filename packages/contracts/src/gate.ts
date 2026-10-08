import { Schema } from "effect"
import { Digest, Id, NonEmptyString, Ref, Stage, stageIndex, Timestamp, Verdict } from "./common"
import { type ContractIssue, issue } from "./issue"
import type { GoalSpec } from "./goal"

// execution-contracts.md §2.2. `not_applicable` is a stage disposition, never a
// fourth way for a criterion to pass.

export const CriterionOutcome = Schema.Literals(["passed", "failed", "blocked", "pending"])

export const GateDecision = Schema.Struct({
  schemaVersion: Schema.Literal("gate/1"),
  decisionId: Id,
  scope: Schema.Literals(["artifact", "stage", "delivery"]),
  stage: Schema.optionalKey(Stage),
  goal: Schema.Struct({ taskId: Id, goalRevision: Schema.Int, acceptanceDigest: Digest }),
  inputEvidenceDigests: Schema.Array(Digest),
  verifier: Schema.Struct({ id: Id, version: NonEmptyString, signatureRef: Ref }),
  decidedAt: Timestamp,
  results: Schema.Array(
    Schema.Struct({
      criterionId: Id,
      outcome: CriterionOutcome,
      failureCode: Schema.optionalKey(Id),
      evidenceRefs: Schema.Array(Ref),
    }),
  ),
  uncovered: Schema.Array(Id),
  verdict: Verdict,
})
export type GateDecision = typeof GateDecision.Type

/** Criteria a gate must judge: its own stage for stage gates, everything for delivery. */
export function criteriaInScope(goal: GoalSpec, scope: GateDecision["scope"], stage?: Stage) {
  if (scope === "delivery") return goal.acceptance
  if (scope === "stage" && stage) return goal.acceptance.filter((item) => item.requiredAtStage === stage)
  return []
}

/** The only verdict the judged results allow; unknown or missing never passes. */
export function expectedVerdict(outcomes: ReadonlyArray<"passed" | "failed" | "blocked" | "pending">, uncovered: number) {
  if (outcomes.includes("failed")) return "failed" as const
  if (uncovered > 0 || outcomes.length === 0 || outcomes.some((o) => o !== "passed")) return "blocked" as const
  return "passed" as const
}

export function validateGate(decision: GateDecision, goal: GoalSpec): ContractIssue[] {
  const issues: ContractIssue[] = []
  if (decision.scope === "stage" && !decision.stage) issues.push(issue("gate_stage_missing", "stage", "Stage gate must name its stage"))
  if (decision.goal.taskId !== goal.taskId || decision.goal.goalRevision !== goal.goalRevision)
    issues.push(issue("gate_wrong_goal", "goal", "Decision targets another goal revision"))

  const inScope = new Set(criteriaInScope(goal, decision.scope, decision.stage).map((item) => item.id))
  const known = new Map(goal.acceptance.map((item) => [item.id, item]))
  const judged: Array<"passed" | "failed" | "blocked" | "pending"> = []

  decision.results.forEach((result, index) => {
    const path = `results[${index}]`
    const criterion = known.get(result.criterionId)
    if (!criterion) return issues.push(issue("gate_unknown_criterion", path, `Unknown criterion ${result.criterionId}`))
    if (!inScope.has(result.criterionId)) {
      const future = decision.stage && stageIndex(criterion.requiredAtStage) > stageIndex(decision.stage)
      if (future && result.outcome !== "pending")
        issues.push(issue("gate_future_criterion", path, `${criterion.id} is required at ${criterion.requiredAtStage}; it must stay pending`))
      return
    }
    if (result.outcome === "passed" && result.evidenceRefs.length === 0)
      issues.push(issue("gate_pass_without_evidence", path, `${criterion.id} passed without evidence`))
    if (result.outcome === "failed" && !result.failureCode)
      issues.push(issue("gate_failure_code_missing", path, `${criterion.id} failed without a failure code`))
    judged.push(result.outcome)
  })

  const covered = new Set(decision.results.map((result) => result.criterionId))
  const missing = [...inScope].filter((id) => !covered.has(id) && !decision.uncovered.includes(id))
  if (missing.length > 0) issues.push(issue("gate_criteria_unaccounted", "results", `Not judged or listed uncovered: ${missing.join(", ")}`))

  const expected = expectedVerdict(judged, decision.uncovered.length + missing.length)
  if (decision.verdict !== expected)
    issues.push(issue("gate_verdict_inconsistent", "verdict", `Results allow ${expected}, decision says ${decision.verdict}`))
  return issues
}
