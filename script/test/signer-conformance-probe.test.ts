import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { assertBlocked, assertObservedCases, decodeSignerProcess } from "../m0/signer-conformance-probe"
import type { VerifierConfig, VerifyRequest } from "../../packages/verifier/src/service"

test("actual child nonzero or killed exits cannot turn a passing JSON string into a result", () => {
  const response = JSON.stringify({ schemaVersion: "verify-candidate-response/1", status: "passed" })
  for (const ending of ["process.exit(2)", "process.kill(process.pid, 'SIGKILL')"]) {
    const child = spawnSync(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(response)});${ending}`], { encoding: "utf8" })
    expect(() => decodeSignerProcess({ status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr })).toThrow()
  }
  const child = spawnSync(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(response)})`], { encoding: "utf8" })
  expect(decodeSignerProcess({ status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr }).status).toBe("passed")
})

test("negative requests require the exact error and no evidence/signature", () => {
  expect(() => assertBlocked({ status: "blocked", error: "candidate_digest_mismatch" }, "candidate_digest_mismatch")).not.toThrow()
  for (const response of [{ status: "failed" }, { status: "blocked", error: "verifier_unavailable" },
    { status: "blocked", error: "candidate_digest_mismatch", signedCheck: {} },
    { status: "blocked", error: "candidate_digest_mismatch", evidence: {} }]) {
    expect(() => assertBlocked(response, "candidate_digest_mismatch")).toThrow()
  }
})

function observationFixture(pass: boolean) {
  const request = { requestId: "request-1", candidateDigest: "candidate", binding: { runId: "run-1" } } as VerifyRequest
  const config = { tests: { digest: "tests" }, runtime: { digest: "runtime" }, runner: { digest: "runner" } } as VerifierConfig
  const report = { schemaVersion: "fixture-verification-evidence/1", requestId: "request-1", candidateDigest: "candidate", binding: request.binding,
    testsDigest: "tests", runtimeDigest: "runtime", runnerDigest: "runner", status: pass ? "passed" : "failed",
    isolation: { network: "none", signerUid: 421, candidateEvaluatedInSigner: false, childContainsKey: false },
    observations: Array.from({ length: 12 }, (_, caseIndex) => ({ caseIndex, matched: pass || caseIndex !== 2,
      reason: !pass && caseIndex === 2 ? "case_failed" : undefined,
      process: { code: 0, signal: null, timedOut: false, overflow: false } })) }
  return { request, config, report }
}

test("bad control must complete 12 comparisons; sandbox failure is never a successful negative", () => {
  const f = observationFixture(false)
  expect(() => assertObservedCases(f.report, f.request, f.config, false)).not.toThrow()
  const bad = structuredClone(f.report)
  bad.observations = [{ caseIndex: 0, matched: false, reason: "child_did_not_complete", process: { code: 71, signal: null, timedOut: false, overflow: false } }]
  expect(() => assertObservedCases(bad, f.request, f.config, false)).toThrow("cases_not_independently_observed")
  bad.observations = f.report.observations.map((item) => ({ ...item, matched: true, reason: undefined }))
  expect(() => assertObservedCases(bad, f.request, f.config, false)).toThrow("control_case_outcome_mismatch")
})

test("positive control rejects missing cases, wrong binding and an unconfined test executor", () => {
  const f = observationFixture(true)
  expect(() => assertObservedCases(f.report, f.request, f.config, true)).not.toThrow()
  expect(() => assertObservedCases({ ...f.report, observations: f.report.observations.slice(1) }, f.request, f.config, true)).toThrow()
  expect(() => assertObservedCases({ ...f.report, binding: { runId: "different-run" } }, f.request, f.config, true)).toThrow()
  expect(() => assertObservedCases({ ...f.report, isolation: { ...f.report.isolation, network: "unverified-test-seam" } }, f.request, f.config, true)).toThrow()
})
