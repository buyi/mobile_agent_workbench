import { expect, test } from "bun:test"
import { checkEvidenceBinding, checkFrozen, digestOf, validateGate } from "../src"
import { baseline } from "./fixtures"

const inputs = () => {
  const goal = baseline("goal")
  goal.targetMatrix[0].os = "Android 15"
  const gate = baseline("gate")
  const evidence = baseline("evidence")
  const acceptanceDigest = digestOf(goal.acceptance)
  gate.goal.acceptanceDigest = acceptanceDigest
  evidence.goal.acceptanceDigest = acceptanceDigest
  evidence.device.deviceIdRef = goal.targetMatrix[0].deviceRef
  return {
    goal, gate, evidence,
    binding: { goal, acceptanceDigest, candidateDigest: evidence.candidateDigest, buildDigest: evidence.buildDigest, now: "2026-10-08T10:30:00Z" },
  }
}

test("a gate binds to the acceptance contents, not only task/revision numbers", () => {
  const { gate, goal } = inputs()
  expect(validateGate(gate, goal)).toEqual([])
  goal.acceptance[3].threshold.value = 1
  expect(validateGate(gate, goal).map((i) => i.code)).toContain("gate_wrong_acceptance")
})

test("duplicate gate results cannot count as independent criterion judgements", () => {
  const { gate, goal } = inputs()
  gate.results.push(structuredClone(gate.results[0]))
  expect(validateGate(gate, goal).map((i) => i.code)).toContain("gate_duplicate_criterion")
})

test("uncovered entries must identify unjudged criteria in the gate's scope", () => {
  const { gate, goal } = inputs()
  gate.verdict = "blocked"
  gate.uncovered = ["ghost", "F1"]
  const codes = validateGate(gate, goal).map((i) => i.code)
  expect(codes).toContain("gate_uncovered_unknown")
  expect(codes).toContain("gate_uncovered_judged")
})

test("evidence from a different device cannot satisfy the frozen device identity", () => {
  const { evidence, binding } = inputs()
  expect(checkEvidenceBinding(evidence, binding)).toEqual([])
  evidence.device.deviceIdRef = "device://android/another-device"
  expect(checkEvidenceBinding(evidence, binding).map((i) => i.code)).toContain("evidence_device_mismatch")
})

test("evidence from another OS version cannot satisfy the frozen device target", () => {
  const { evidence, binding } = inputs()
  evidence.device.os = "Android 14"
  expect(checkEvidenceBinding(evidence, binding).map((i) => i.code)).toContain("evidence_device_mismatch")
})

test("a caller cannot reuse an old acceptance digest with changed criteria", () => {
  const { evidence, binding } = inputs()
  binding.goal.acceptance[0].expected = "different acceptance"
  expect(checkEvidenceBinding(evidence, binding).map((i) => i.code)).toContain("evidence_wrong_acceptance")
})

test("an unversioned rubric keeps a goal draft", () => {
  const { goal } = inputs()
  expect(checkFrozen(goal)).toEqual([])
  goal.acceptance[2].rubricRef = "rubric://readability/latest"
  expect(checkFrozen(goal).map((i) => i.code)).toContain("unpinned")
})

test("a declared device target must freeze identity and OS before execution", () => {
  const { goal } = inputs()
  delete goal.targetMatrix[0].deviceRef
  delete goal.targetMatrix[0].os
  const codes = checkFrozen(goal).map((i) => i.code)
  expect(codes).toContain("device_identity_missing")
  expect(codes).toContain("device_os_missing")
})
