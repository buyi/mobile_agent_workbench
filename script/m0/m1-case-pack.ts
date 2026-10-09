import { parse } from "../../packages/contracts/src/registry"

// Consistency checks for local preparation data, never resource authorization.
// The normal Goal/Policy/Evidence parsers remain the execution contracts.
export function checkM1CasePack(input: {
  goal: any; confirmed: any; implementation: any; policy: any; fixtures: any; pack: any
  refs: Record<string, string>
}): { valid: boolean; issues: string[]; formalPolicyAccepted: boolean; deliveryRunAllowed: false } {
  const issues: string[] = []
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const check = (condition: boolean, code: string) => { if (!condition) issues.push(code) }
  const { goal, confirmed, implementation, policy, fixtures, pack, refs } = input
  let formalPolicyAccepted = false
  try {
    const standards = confirmed.userConfirmed.acceptance
    const delivery = confirmed.userConfirmed.m1Delivery
    for (const value of [policy, fixtures, pack]) {
      check(value.version === 1 && value.status === "prepared-not-protected" && value.deliveryRunAllowed === false,
        "preparation_must_not_claim_protection_or_admission")
    }
    check(policy.schemaVersion === "m1-execution-policy-preparation/1" &&
      fixtures.schemaVersion === "m1-diagnostics-fixtures/1" && pack.schemaVersion === "m1-diagnostics-case-pack/1", "unknown_preparation_version")
    check(policy.publication.registered === false && policy.publication.protected === false && policy.publication.policyRefPublished === false,
      "unproved_policy_publication")
    formalPolicyAccepted = parse("policy", policy.policyDraft).ok
    check(!formalPolicyAccepted && goal.policyRef === undefined, "incomplete_policy_must_not_be_published")
    check(same(pack.userAcceptance, standards) && same(goal.acceptance.map((x: any) => ({ id: x.id, expected: x.expected })), standards),
      "user_acceptance_changed")
    check(same(policy.policyDraft.permissions.writablePaths, implementation.allowedPaths) &&
      same(goal.scope.allowedPaths, implementation.allowedPaths), "writable_scope_changed")
    check(same(pack.budgets, delivery.budgets) && same(goal.budgets, delivery.budgets) &&
      Object.entries(delivery.budgets).every(([key, value]) => policy.budget[key] === value), "m1_budget_changed")
    check(policy.budget.modelId === delivery.modelId && policy.budget.allowUnknownCost === delivery.allowUnknownCost &&
      policy.budget.m0DeadlineExtended === false && policy.budget.startsOnlyAfterM0Passes === true, "budget_authority_changed")
    check(pack.observation.minutes === delivery.observation.minutes && pack.observation.minPathRuns === delivery.observation.minPathRuns &&
      pack.observation.minHealthProbes === delivery.observation.minPathRuns &&
      ["minutes", "minPathRuns", "minHealthProbes"].every((key) => pack.observation[key] === goal.delivery.observation[key]), "observation_standard_changed")
    check(pack.confirmedInputsRef === refs["confirmed-inputs"] && policy.provenance.userStandardsRef === refs["confirmed-inputs"] &&
      policy.provenance.scopeRef === refs["implementation-scope"] && fixtures.implementationScopeRef === refs["implementation-scope"] &&
      pack.policyPreparationRef === refs["execution-policy-preparation"] && pack.cleanupRef === refs["execution-policy-preparation"] &&
      pack.fixtureRef === refs["diagnostics-fixtures"] && pack.rubricRef === refs["large-text-rubric"], "preparation_reference_mismatch")
    check(same(goal.resources.fixtureRefs, [refs["diagnostics-fixtures"], refs["diagnostics-case-pack"]]), "goal_fixture_reference_mismatch")
    check(pack.sourceRevision === implementation.sourceRevision && fixtures.sourceRevision === implementation.sourceRevision &&
      ["projectId", "taskId", "goalRevision"].every((key) => pack.goalIdentity[key] === goal[key]), "preparation_identity_mismatch")
    const criterionIds = new Set(standards.map((item: any) => item.id))
    const observedCriteria = new Set(pack.cases.flatMap((item: any) => item.criterionIds))
    check(criterionIds.size === observedCriteria.size && [...criterionIds].every((id) => observedCriteria.has(id)), "case_criterion_coverage_changed")
    check(pack.cases.every((item: any) => item.steps.length > 0 && item.outputs.length > 0 && item.oracle && item.positiveControl && item.negativeControl),
      "case_or_control_missing")
    check(same(pack.stages.map((stage: any) => stage.stage), ["requirements", "design", "development", "verification", "release", "operations"]) &&
      pack.stages.every((stage: any) => stage.inputs.length > 0 && stage.outputs.length > 0 && stage.shortcut), "stage_io_missing")
    check(fixtures.executionStatus === "not-run" && pack.executionStatus === "not-run" && fixtures.containsRealAccountOrCredential === false &&
      pack.evidenceContract.builderFormalEvidenceAllowed === false, "preparation_must_not_claim_execution_or_builder_evidence")
    const fields = ["version", "build", "environment"]
    check(same(fixtures.fieldContract.allowedFields, fields) && same(policy.sensitiveInformation.displayAndCopyFields, fields) &&
      fixtures.cases.every((item: any) => same(Object.keys(item.expected), fields) && Object.values(item.expected).every((value) => typeof value === "string")),
      "fixture_field_allowlist_changed")
    const sentinel = fixtures.cases.find((item: any) => item.id === "field-allowlist")
    check(sentinel?.forbiddenValues?.length >= 5 && sentinel.forbiddenValues.every((value: string) =>
      Object.values(sentinel.input).includes(value) && !Object.values(sentinel.expected).includes(value)), "sensitive_negative_control_missing")
    check(["independent-journal", "exclusive-device-broker", "local-delivery-channel", "protected-case-runner", "m0-entry-gate"]
      .every((id) => policy.admissionBlockers.includes(id)), "known_admission_blocker_removed")
  } catch {
    issues.push("malformed_preparation_data")
  }
  return { valid: issues.length === 0, issues, formalPolicyAccepted, deliveryRunAllowed: false }
}
