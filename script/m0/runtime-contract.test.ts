import { afterAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

type Json = Record<string, any>
const evidenceRootInput = process.env.LOOPIT_RUNTIME_EVIDENCE_ROOT
const reportDirectory = process.env.LOOPIT_BENCH_OUT
if (!evidenceRootInput || !reportDirectory) throw new Error("runtime-contract must run through bench verify --suite runtime-contract --evidence-root <bundle>")
const root = realpathSync(resolve(evidenceRootInput))
const inputs: Array<{ path: string; digest: string; bytes: number }> = []

function contained(base: string, path: string) {
  const rel = relative(base, path)
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function readPinned(path: string, expectedDigest?: string, expectedBytes?: number): Buffer {
  const absolute = resolve(root, path)
  if (!contained(root, absolute)) throw new Error(`evidence path escapes bundle: ${path}`)
  let cursor = root
  for (const part of relative(root, absolute).split(sep)) {
    cursor = join(cursor, part)
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`symlink evidence is not accepted: ${path}`)
  }
  const bytes = readFileSync(absolute)
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
  if (expectedDigest && digest !== expectedDigest) throw new Error(`evidence digest mismatch: ${path}`)
  if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) throw new Error(`evidence byte count mismatch: ${path}`)
  inputs.push({ path, digest, bytes: bytes.byteLength })
  return bytes
}

function document(path: string): Json {
  return JSON.parse(readPinned(path).toString("utf8"))
}

function verifyAudit(reportPath: string, schemaVersion: string, requiredChecks: number) {
  const audit = document(reportPath)
  expect(audit.schemaVersion).toBe(schemaVersion)
  expect(audit.status).toBe("passed")
  expect(audit.checks).toBeArray()
  expect(audit.checks.length).toBeGreaterThanOrEqual(requiredChecks)
  expect(audit.checks.every((check: Json) => check.passed === true)).toBe(true)
  expect(audit.boundaries.completeM0).toBe(false)
  expect(audit.boundaries.gate).toBe("not_evaluated")
  expect(audit.sourceArtifacts).toBeArray()
  expect(audit.sourceArtifacts.length).toBeGreaterThan(0)
  for (const source of audit.sourceArtifacts) {
    expect(typeof source.path).toBe("string")
    expect(source.path.length).toBeGreaterThan(0)
    const relativePath = join(dirname(reportPath), source.path)
    readPinned(relativePath, source.digest, source.bytes ?? source.size)
  }
  return audit
}

let output: Json = {
  schemaVersion: "m0-runtime-contract-inputs/1",
  status: "incomplete",
  milestonePassed: false,
  evidence: [],
  boundaries: {
    scope: "Historical report aggregation only; this is not a fresh model run, OS observation, M0 manifest, attestation, or M1 admission.",
    automaticUnknownExecutionRecovery: "not_supported",
  },
}

test("bounded OpenCode task remains explicitly distinct from M0/M1 completion", () => {
  const reportPath = "control-loop-actual/code-task-passed/reports/result.json"
  const report = document(reportPath)
  expect(report.schemaVersion).toBe("m0-control-loop-result/1")
  expect(report.status).toBe("passed")
  expect(report.run.status).toBe("succeeded")
  expect(report.run.usage.humanInterventions).toBe(0)
  expect(report.processStopProof.noLiveWorkerProcesses).toBe(true)
  expect(report.processStopProof.userDomainAbsent).toBe(true)
  expect(report.processStopProof.externalActionsVerified).toBe(false)
  expect(report.eventReplayMatches).toBe(true)
  expect(report.milestonePassed).toBe(false)
  expect(report.m1FeatureImplemented).toBe(false)
  output.evidence.push({ id: "bounded-opencode-delivery", path: reportPath, status: report.status, taskId: report.run.taskId, runId: report.run.runId })
})

test("A05 deployed control matrix has a complete independent byte audit", () => {
  const reportPath = "control-matrix-actual/independent-audit.json"
  const audit = verifyAudit(reportPath, "m0-control-matrix-independent-audit/1", 80)
  expect(audit.summary.failed).toBe(0)
  expect(audit.summary.passed).toBeGreaterThanOrEqual(80)
  expect(audit.boundaries.A05).toBe("deployed control-matrix slice proven")
  expect(audit.boundaries.actualModelInference).toBe(false)
  output.evidence.push({ id: "A05-controls", path: reportPath, status: audit.status, checks: audit.summary.passed })
})

test("A06 unknown-owner cold refusal keeps ambiguous execution blocked", () => {
  const reportPath = "owner-loss-actual-b/independent-audit.json"
  const audit = verifyAudit(reportPath, "m0-owner-loss-independent-audit/1", 100)
  expect(audit.summary.failed).toBe(0)
  expect(audit.summary.passed).toBeGreaterThanOrEqual(100)
  expect(audit.boundaries.A06RefusalScenario).toBe("verified")
  expect(audit.boundaries.automaticUnknownExecutionRelease).toBe("unsupported; reservation retained")
  expect(audit.boundaries.reservationReleased).toBe(false)
  expect(audit.boundaries.nativeExitFabricated).toBe(false)
  output.evidence.push({ id: "A06-unknown-owner-refusal", path: reportPath, status: audit.status, checks: audit.summary.passed })
})

afterAll(() => {
  output = {
    ...output,
    status: output.evidence.length === 3 ? "passed" : "incomplete",
    observedAt: new Date().toISOString(),
    evidenceRoot: root,
    sourceArtifacts: inputs,
    milestonePassed: false,
  }
  writeFileSync(join(reportDirectory, "runtime-contract-inputs.json"), `${JSON.stringify(output, null, 2)}\n`, { flag: "w", mode: 0o600 })
})
