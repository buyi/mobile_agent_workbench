import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { parse } from "../../packages/contracts/src/registry"
import { checkFrozen } from "../../packages/contracts/src/goal"
import { byteDigest, compareApps, inspectApp } from "./ios-artifact"
import { checkM1CasePack } from "./m1-case-pack"

// Read-only preparation audit. This neither registers resources nor signs a Gate.
const directory = resolve(import.meta.dir, "../../docs/m0/m1-inputs")
const readJSON = (path: string) => JSON.parse(readFileSync(path, "utf8"))
const draft = readJSON(resolve(directory, "goal.draft.json"))
const confirmations = readJSON(resolve(directory, "confirmed-inputs.json"))
const implementation = readJSON(resolve(directory, "implementation-scope.json"))
const policy = readJSON(resolve(directory, "execution-policy.draft.json"))
const fixtures = readJSON(resolve(directory, "diagnostics-fixtures.json"))
const pack = readJSON(resolve(directory, "diagnostics-case-pack.json"))
const manifest = readJSON(resolve(directory, "materials.json")) as {
  repository: { worktree: string; revision: string; expectedPorcelain: string; expectedDiffDigest: string }
  sourceMetadataNotes?: string[]
  materials: Array<{ id: string; kind: string; path: string; digest: string; ref: string;
    includeInGoalInputRefs: boolean; inventoryMaterialId?: string }>
}

const materialChecks: Array<{ id: string; matched: boolean; expectedDigest: string; actualDigest?: string; error?: string }> = []
for (const item of manifest.materials) {
  try {
    const url = new URL(item.ref)
    if (url.protocol !== "file:" || fileURLToPath(url) !== item.path || url.hash !== `#${item.digest}`)
      throw new Error("Local resource path and pinned reference disagree")
    let actualDigest: string
    if (item.kind === "file") actualDigest = byteDigest(readFileSync(item.path))
    else if (item.kind === "ios-app-directory") {
      const inventoryMaterial = manifest.materials.find((candidate) => candidate.id === item.inventoryMaterialId)
      if (!inventoryMaterial) throw new Error("Missing baseline inventory material")
      const observed = await inspectApp(item.path)
      const expected = readJSON(inventoryMaterial.path)
      if (!compareApps(expected, observed).matched) throw new Error("Baseline app no longer matches its byte inventory and identity")
      actualDigest = observed.digest
    } else throw new Error(`Unsupported local material kind: ${item.kind}`)
    materialChecks.push({ id: item.id, expectedDigest: item.digest, actualDigest, matched: actualDigest === item.digest })
  } catch (error) {
    materialChecks.push({ id: item.id, expectedDigest: item.digest, matched: false, error: String(error) })
  }
}

const readGit = (args: string[]) => {
  const result = spawnSync("/usr/bin/git", ["-C", manifest.repository.worktree, ...args], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", GIT_OPTIONAL_LOCKS: "0" },
  })
  if (result.error || result.signal || result.status !== 0) throw new Error(`Read-only Git check failed: ${args[0]}`)
  return result.stdout
}
let sourceCheck: { matched: boolean; revision?: string; changedFiles?: string; diffDigest?: string; error?: string }
try {
  const revision = readGit(["rev-parse", "HEAD"]).trim()
  const changedFiles = readGit(["status", "--porcelain"])
  // Match the recorded patch format, independent of Git's automatic abbreviation
  // width. The complete base commit and prepared lock-file bytes are also pinned.
  const diffDigest = byteDigest(Buffer.from(readGit(["diff", "--binary", "--abbrev=9", "HEAD"])))
  sourceCheck = { revision, changedFiles, diffDigest,
    matched: revision === manifest.repository.revision && changedFiles === manifest.repository.expectedPorcelain && diffDigest === manifest.repository.expectedDiffDigest }
} catch (error) { sourceCheck = { matched: false, error: String(error) } }

const inputRefs = manifest.materials.filter((item) => item.includeInGoalInputRefs).map((item) => item.ref)
const inputRefsMatch = JSON.stringify(draft.scope?.inputRefs) === JSON.stringify(inputRefs)
const expectationsMatch = JSON.stringify(draft.acceptance?.map(({ id, expected }: { id: string; expected: string }) => ({ id, expected }))) ===
  JSON.stringify(confirmations.userConfirmed.acceptance)
const implementationScopeMatches = implementation.sourceRevision === manifest.repository.revision &&
  JSON.stringify(draft.scope?.allowedPaths) === JSON.stringify(implementation.allowedPaths) &&
  implementation.sources.every((source: { path: string; revision: string; digest: string }) =>
    source.revision === manifest.repository.revision && !source.path.startsWith("/") && !source.path.split("/").includes("..") &&
    byteDigest(readFileSync(resolve(manifest.repository.worktree, source.path))) === source.digest)
const schema = parse("goal", draft)
const m1BudgetConfirmed = JSON.stringify(draft.budgets) === JSON.stringify(confirmations.userConfirmed.m1Delivery?.budgets) &&
  confirmations.userConfirmed.m1Delivery?.allowUnknownCost === true && confirmations.userConfirmed.m1Delivery?.m0DeadlineExtended === false
const casePackCheck = checkM1CasePack({ goal: draft, confirmed: confirmations, implementation, policy, fixtures, pack,
  refs: Object.fromEntries(manifest.materials.map((item) => [item.id, item.ref])) })
const materialsValid = materialChecks.every((item) => item.matched) && sourceCheck.matched && inputRefsMatch && expectationsMatch && implementationScopeMatches && m1BudgetConfirmed && casePackCheck.valid

console.log(JSON.stringify({
  schemaVersion: "m1-preparation-report/1", observedAt: new Date().toISOString(),
  status: materialsValid ? "blocked" : "invalid-inputs", deliveryRunAllowed: false,
  scope: "Local input preparation only; not a frozen GoalSpec, resource registration, MilestoneManifest, or GateDecision",
  materialChecks, sourceCheck, sourceMetadataNotes: manifest.sourceMetadataNotes ?? [], inputRefsMatch, unchangedUserExpectations: expectationsMatch,
  implementationScopeMatches,
  casePackCheck,
  formalGoalSchema: schema.ok ? { accepted: true, frozenIssues: checkFrozen(schema.value) } : { accepted: false, issues: schema.issues },
  unresolved: confirmations.unresolved,
  budgetScope: { m0ExperimentAlreadyConfirmed: true, m1CompleteBudgetConfirmed: m1BudgetConfirmed, m0BudgetCopiedIntoM1: false },
  limitations: [
    "Missing required GoalSpec fields are intentional. No placeholder digest or zero-cost budget has been substituted.",
    "Only local files and source metadata were rechecked. Device state and earlier operator experiment results remain historical evidence.",
    "The baseline app is not the M1 feature candidate; a byte match proves material identity, not feature acceptance.",
    "The report cannot authorize delivery even if the structural schema later parses. Freeze the missing decisions and resources separately.",
    "Version 1 policy/fixtures/Case Pack are prepared-not-protected. Synthetic test inputs are not executed tests, device access or independent evidence.",
  ],
}, null, 2))
process.exitCode = materialsValid ? 2 : 1
