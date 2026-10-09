import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { checkM1CasePack } from "../m0/m1-case-pack"

const directory = resolve(import.meta.dir, "../../docs/m0/m1-inputs")
const read = (name: string) => JSON.parse(readFileSync(resolve(directory, name), "utf8"))
const prepared = {
  goal: read("goal.draft.json"), confirmed: read("confirmed-inputs.json"), implementation: read("implementation-scope.json"),
  policy: read("execution-policy.draft.json"), fixtures: read("diagnostics-fixtures.json"), pack: read("diagnostics-case-pack.json"),
  refs: Object.fromEntries(read("materials.json").materials.map((item: any) => [item.id, item.ref])),
}

describe("M1 preparation consistency is never admission", () => {
  test("current material set stays valid preparation with rejected incomplete policy", () => {
    expect(checkM1CasePack(prepared)).toEqual({ valid: true, issues: [], formalPolicyAccepted: false, deliveryRunAllowed: false })
  })
  for (const [name, code, mutate] of [
    ["expanded budget", "m1_budget_changed", (x: typeof prepared) => {
      x.goal.budgets.wallMinutes = 240; x.pack.budgets.wallMinutes = 240; x.policy.budget.wallMinutes = 240
    }],
    ["changed acceptance", "user_acceptance_changed", (x: typeof prepared) => { x.pack.userAcceptance[0].expected = "Show any version" }],
    ["broader write scope", "writable_scope_changed", (x: typeof prepared) => { x.policy.policyDraft.permissions.writablePaths.push("ios/**") }],
    ["extra copied token", "fixture_field_allowlist_changed", (x: typeof prepared) => {
      x.fixtures.cases.find((item: any) => item.id === "field-allowlist").expected.token = "SYNTHETIC_TOKEN_DO_NOT_COPY"
    }],
    ["wrong fixture pin", "preparation_reference_mismatch", (x: typeof prepared) => { x.pack.fixtureRef = x.refs["large-text-rubric"] }],
    ["claimed deployment", "unproved_policy_publication", (x: typeof prepared) => { x.policy.publication.protected = true }],
    ["missing authority blocker", "known_admission_blocker_removed", (x: typeof prepared) => {
      x.policy.admissionBlockers = x.policy.admissionBlockers.filter((id: string) => id !== "independent-journal")
    }],
    ["publishing a partial policy", "incomplete_policy_must_not_be_published", (x: typeof prepared) => { x.goal.policyRef = x.refs["execution-policy-preparation"] }],
  ] as const) {
    test(name, () => {
      const changed = structuredClone(prepared)
      mutate(changed)
      const result = checkM1CasePack(changed)
      expect(result.valid).toBe(false)
      expect(result.deliveryRunAllowed).toBe(false)
      expect(result.issues).toContain(code)
    })
  }
  test("malformed data fails closed without issuing execution authority", () => {
    const changed = structuredClone(prepared)
    changed.pack.cases = null
    expect(checkM1CasePack(changed)).toMatchObject({ valid: false, deliveryRunAllowed: false, issues: ["malformed_preparation_data"] })
  })
})
