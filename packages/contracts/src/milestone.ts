import { Schema } from "effect"
import { Digest, Id, NonEmptyString, Ref, Timestamp, Verdict } from "./common"
import { type ContractIssue, issue } from "./issue"

// milestones/README.md §2. Issued by an independent checker; a builder cannot
// flip its own record to passed.

export const TestResultSummary = Schema.Struct({
  testId: Id,
  required: Schema.Boolean,
  outcome: Schema.Literals(["passed", "failed", "blocked", "notRun"]),
  evidenceRef: Schema.optionalKey(Ref),
})

export const MilestoneManifest = Schema.Struct({
  schemaVersion: Schema.Literal("milestone/1"),
  milestone: Schema.Literals(["M0", "M1", "M2", "M3"]),
  specDigest: Digest,
  sourceRevision: NonEmptyString,
  contractVersions: Schema.Array(NonEmptyString),
  upstreamManifestRefs: Schema.Array(Schema.Struct({ ref: Ref, digest: Digest })),
  inputRefs: Schema.Array(Ref),
  outputRefs: Schema.Array(Ref),
  capabilityMatrixRef: Ref,
  testResults: Schema.Array(TestResultSummary),
  testResultsRef: Ref,
  metricsRef: Ref,
  unresolvedConstraints: Schema.Array(
    Schema.Struct({ id: Id, reason: NonEmptyString, impact: NonEmptyString, retryTrigger: NonEmptyString }),
  ),
  issuer: Schema.Struct({ kind: Schema.Literals(["verifier", "builder"]), id: Id }),
  issuedAt: Timestamp,
  verdict: Verdict,
})
export type MilestoneManifest = typeof MilestoneManifest.Type

export function validateMilestone(manifest: MilestoneManifest): ContractIssue[] {
  const issues: ContractIssue[] = []
  if (manifest.issuer.kind !== "verifier")
    issues.push(issue("milestone_untrusted_issuer", "issuer", "Only an independent verifier may issue a manifest"))
  if (manifest.milestone !== "M0" && manifest.upstreamManifestRefs.length === 0)
    issues.push(issue("milestone_upstream_missing", "upstreamManifestRefs", `${manifest.milestone} must reference its upstream manifest`))

  const required = manifest.testResults.filter((result) => result.required)
  const expected = required.some((r) => r.outcome === "failed")
    ? "failed"
    : required.length === 0 || manifest.unresolvedConstraints.length > 0 || required.some((r) => r.outcome !== "passed" || !r.evidenceRef)
      ? "blocked"
      : "passed"
  if (manifest.verdict !== expected)
    issues.push(issue("milestone_verdict_inconsistent", "verdict", `Test results allow ${expected}, manifest says ${manifest.verdict}`))
  return issues
}
