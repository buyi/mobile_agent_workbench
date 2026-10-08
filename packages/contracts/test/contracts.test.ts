import { describe, expect, test } from "bun:test"
import {
  canTransition,
  checkEvidenceBinding,
  digestOf,
  mayDispatch,
  operationTransitions,
  parse,
  runTransitions,
  terminalRunStatuses,
  type RunStatus,
} from "../src"
import { baseline, cases, run } from "./fixtures"

describe("contract fixtures (M0-A01)", () => {
  for (const item of cases().cases) {
    test(`${item.id} -> ${item.expect}`, () => {
      const codes = run(item).map((i) => i.code)
      if (item.expect === "ok") expect(codes).toEqual([])
      else expect(codes).toContain(item.expect)
    })
  }

  test("every contract kind has a valid baseline and at least one negative case", () => {
    const byFixture = Map.groupBy(cases().cases, (item) => item.fixture)
    for (const [fixture, items] of byFixture) {
      expect(items.some((i) => i.expect === "ok"), fixture).toBe(true)
      expect(items.some((i) => i.expect !== "ok"), fixture).toBe(true)
    }
  })
})

describe("evidence binding (S08/S09/S19)", () => {
  const goal = parse("goal", baseline("goal"))
  if (!goal.ok) throw new Error("goal baseline must parse")
  const evidence = parse("evidence", baseline("evidence"))
  if (!evidence.ok) throw new Error("evidence baseline must parse")
  const binding = {
    goal: goal.value,
    acceptanceDigest: evidence.value.goal.acceptanceDigest,
    candidateDigest: evidence.value.candidateDigest,
    buildDigest: evidence.value.buildDigest,
    now: "2026-10-08T10:30:00Z",
    validFor: { maxAgeMinutes: 60 },
  }
  const codes = (patch: (e: any) => void, overrides: Partial<typeof binding> = {}) => {
    const value = structuredClone(evidence.value) as any
    patch(value)
    return checkEvidenceBinding(value, { ...binding, ...overrides }).map((i) => i.code)
  }

  test("matching evidence binds", () => expect(codes(() => {})).toEqual([]))
  test("new candidate invalidates", () =>
    expect(codes(() => {}, { candidateDigest: `sha256:${"d".repeat(64)}` })).toContain("evidence_stale_candidate"))
  test("new build invalidates", () =>
    expect(codes(() => {}, { buildDigest: `sha256:${"e".repeat(64)}` })).toContain("evidence_stale_build"))
  test("changed acceptance invalidates", () =>
    expect(codes(() => {}, { acceptanceDigest: `sha256:${"f".repeat(64)}` })).toContain("evidence_wrong_acceptance"))
  test("expired evidence", () => expect(codes(() => {}, { now: "2026-10-08T12:00:00Z" })).toContain("evidence_expired"))
  test("emulator cannot satisfy physical", () =>
    expect(codes((e) => (e.device.deviceKind = "emulator"))).toContain("evidence_device_mismatch"))
  test("iOS cannot satisfy android", () => expect(codes((e) => (e.device.platform = "ios"))).toContain("evidence_device_mismatch"))
  test("old install cannot back a new build", () =>
    expect(codes((e) => (e.device.installedBuildReceipt.buildDigest = `sha256:${"0".repeat(64)}`))).toContain(
      "evidence_install_mismatch",
    ))
  test("missing device evidence for UI criterion", () => expect(codes((e) => delete e.device)).toContain("evidence_device_missing"))
  test("builder cannot issue formal evidence", () =>
    expect(codes((e) => (e.issuer.kind = "builder"))).toContain("evidence_untrusted_issuer"))
  test("revoked evidence", () => expect(codes((e) => (e.revoked = true))).toContain("evidence_revoked"))
})

describe("state rules", () => {
  test("terminal runs never transition", () => {
    for (const status of terminalRunStatuses) expect(runTransitions[status]).toEqual([])
  })
  test("pause and cancel only finish through their in-progress states", () => {
    const into = (target: RunStatus) =>
      (Object.keys(runTransitions) as RunStatus[]).filter((from) => canTransition(from, target))
    expect(into("paused")).toEqual(["pausing"])
    expect(into("cancelled")).toEqual(["cancelling"])
  })
  test("indeterminate operations are only resolved by reconciliation", () => {
    expect(operationTransitions.indeterminate).not.toContain("dispatched")
  })
  test("stale generation or epoch may not dispatch", () => {
    const op = { ...baseline("operation"), state: "intent_recorded" }
    expect(mayDispatch(op, { generation: 3, epoch: 1 })).toBe(true)
    expect(mayDispatch(op, { generation: 2, epoch: 1 })).toBe(false)
    expect(mayDispatch(op, { generation: 3, epoch: 0 })).toBe(false)
    expect(mayDispatch({ ...op, state: "indeterminate" }, { generation: 3, epoch: 1 })).toBe(false)
  })
})

test("digest is canonical over key order", () => {
  expect(digestOf({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(digestOf({ b: [1, { d: 3, c: 2 }], a: 1 }))
  expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }))
})
