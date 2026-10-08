import { Schema } from "effect"
import { Digest, Id, NonEmptyString, NonNegativeInt, PositiveInt, Ref, Stage, Stages, Timestamp, Usage } from "./common"
import { type ContractIssue, duplicates, findCycle, issue } from "./issue"

// execution-contracts.md §3: six fixed stages, typed plan graph, legal short-circuit.

export const StageDisposition = Schema.Struct({
  stageId: Id,
  mode: Schema.Literals(["reused", "not_applicable"]),
  reason: NonEmptyString,
  ruleRef: Ref,
  inputDigests: Schema.Array(Digest),
  reusedArtifactRefs: Schema.Array(Ref),
  validatedBy: Id,
  validatedAt: Timestamp,
})
export type StageDisposition = typeof StageDisposition.Type

export const StageResult = Schema.Struct({
  schemaVersion: Schema.Literal("stage-result/1"),
  stageRunId: Id,
  stage: Stage,
  status: Schema.Literals(["passed", "failed", "blocked", "reused", "not_applicable", "cancelled"]),
  inputRefs: Schema.Array(Ref),
  outputRefs: Schema.Array(Ref),
  attempts: Schema.Array(Schema.Struct({ attemptId: Id, status: Id, startedAt: Timestamp, endedAt: Schema.optionalKey(Timestamp) })),
  checks: Schema.Array(Schema.Struct({ checkId: Id, outcome: Schema.Literals(["passed", "failed", "blocked"]), evidenceRef: Schema.optionalKey(Ref) })),
  failure: Schema.optionalKey(Schema.Struct({ failureClass: Id, fingerprint: Digest, message: NonEmptyString })),
  disposition: Schema.optionalKey(StageDisposition),
  nextProposal: Schema.optionalKey(NonEmptyString),
  timing: Schema.Struct({ queuedMs: NonNegativeInt, runMs: NonNegativeInt }),
  usage: Usage,
})
export type StageResult = typeof StageResult.Type

/** A short-circuited stage must carry its disposition; a run stage must not. */
export function validateStageResult(result: StageResult): ContractIssue[] {
  const shortCircuit = result.status === "reused" || result.status === "not_applicable"
  if (shortCircuit && !result.disposition)
    return [issue("disposition_missing", "disposition", `${result.status} requires a StageDisposition`)]
  if (shortCircuit && result.disposition!.mode !== result.status)
    return [issue("disposition_mismatch", "disposition.mode", "Disposition mode must match status")]
  if (result.status === "reused" && result.disposition!.reusedArtifactRefs.length === 0)
    return [issue("reuse_without_artifacts", "disposition.reusedArtifactRefs", "Reuse must name reused artifacts")]
  if (result.status === "failed" && !result.failure)
    return [issue("failure_missing", "failure", "A failed stage must record failure class and fingerprint")]
  return []
}

export const PlanNode = Schema.Struct({
  nodeId: Id,
  stage: Stage,
  // Short-circuited stages stay in the graph so dependants see an explicit disposition.
  mode: Schema.Literals(["run", "reused", "not_applicable"]),
  requiredInputs: Schema.Array(Id),
  outputKinds: Schema.Array(Id),
  capabilities: Schema.Array(Id),
  budgetShareMinutes: NonNegativeInt,
})

export const Plan = Schema.Struct({
  schemaVersion: Schema.Literal("plan/1"),
  planId: Id,
  version: PositiveInt,
  goal: Schema.Struct({ taskId: Id, goalRevision: PositiveInt, digest: Digest }),
  budgetMinutes: PositiveInt,
  nodes: Schema.Array(PlanNode).check(Schema.isMinLength(1)),
  edges: Schema.Array(Schema.Struct({ from: Id, to: Id, artifactKind: Id })),
})
export type Plan = typeof Plan.Type

/** Harness checks on a model-proposed plan: DAG, typed edges, inputs satisfied, budget conserved. */
export function validatePlan(plan: Plan): ContractIssue[] {
  const issues: ContractIssue[] = []
  const nodes = new Map(plan.nodes.map((node) => [node.nodeId, node]))
  for (const id of duplicates(plan.nodes.map((node) => node.nodeId)))
    issues.push(issue("plan_duplicate_node", `nodes.${id}`, `Duplicate node ${id}`))

  plan.edges.forEach((edge, index) => {
    const from = nodes.get(edge.from)
    const to = nodes.get(edge.to)
    if (!from || !to) {
      issues.push(issue("plan_edge_unknown_node", `edges[${index}]`, `Edge ${edge.from} -> ${edge.to} names an unknown node`))
      return
    }
    if (!from.outputKinds.includes(edge.artifactKind))
      issues.push(issue("plan_edge_type_mismatch", `edges[${index}]`, `${edge.from} does not output ${edge.artifactKind}`))
    if (!to.requiredInputs.includes(edge.artifactKind))
      issues.push(issue("plan_edge_type_mismatch", `edges[${index}]`, `${edge.to} does not consume ${edge.artifactKind}`))
  })

  for (const node of plan.nodes) {
    const supplied = new Set(plan.edges.filter((edge) => edge.to === node.nodeId).map((edge) => edge.artifactKind))
    for (const input of node.requiredInputs)
      if (input !== "goal-spec" && !supplied.has(input))
        issues.push(issue("plan_input_unsatisfied", `nodes.${node.nodeId}`, `No edge supplies ${input}`))
  }

  const cycle = findCycle(nodes.keys(), (id) => plan.edges.filter((edge) => edge.from === id).map((edge) => edge.to))
  if (cycle) issues.push(issue("plan_cycle", "edges", `Cycle: ${cycle.join(" -> ")}`))

  const total = plan.nodes.reduce((sum, node) => sum + node.budgetShareMinutes, 0)
  if (total > plan.budgetMinutes)
    issues.push(issue("plan_budget_exceeded", "nodes", `Node budgets ${total}m exceed plan budget ${plan.budgetMinutes}m`))

  for (const stage of Stages)
    if (!plan.nodes.some((node) => node.stage === stage))
      issues.push(
        issue("plan_stage_missing", "nodes", `Stage ${stage} has no node; record it as reused/not_applicable instead of omitting it`),
      )
  return issues
}
