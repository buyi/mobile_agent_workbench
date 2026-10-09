/** The controller and read-only deployed probe share this exact acceptance boundary. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import { dirname } from "node:path"
import { digestOf, checkFrozen, parse } from "../../packages/contracts/src"
import { acceptSignedFixtureCheck, byteDigest, type Binding, type FixtureAcceptanceWindow, type verifySignedCheck } from "../../packages/verifier/src/service"

export function requireSignedFixtureAcceptance(
  signed: unknown, evidence: Buffer, publicKey: string,
  expected: Parameters<typeof verifySignedCheck>[2],
  window: Pick<FixtureAcceptanceWindow, "notBefore" | "deadlineAt">,
) {
  // Do not forward a caller-supplied clock, including an extra runtime property.
  const result = acceptSignedFixtureCheck(signed, evidence, publicKey, expected, { notBefore: window.notBefore, deadlineAt: window.deadlineAt })
  if (!result.accepted) throw new Error(`evidence_acceptance_rejected:${result.reason}`)
  return result
}

export const HISTORICAL_JOB = "/private/var/loopit/m0-runs/m0-code-loop-20261009a"
export const HISTORICAL_INPUTS = {
  goal: `${HISTORICAL_JOB}/public/goal.json`,
  source: `${HISTORICAL_JOB}/public/source.ts`,
  tests: `${HISTORICAL_JOB}/public/tests.json`,
  publicKey: `${HISTORICAL_JOB}/control/verifier-public.pem`,
  signedCheck: `${HISTORICAL_JOB}/control/reports/signed-check.json`,
  evidence: `${HISTORICAL_JOB}/control/reports/verification-evidence.json`,
  result: `${HISTORICAL_JOB}/control/reports/result.json`,
  execution: `${HISTORICAL_JOB}/control/reports/execution.json`,
  budget: `${HISTORICAL_JOB}/control/execution-budget.json`,
} as const
type Role = keyof typeof HISTORICAL_INPUTS
type Raw = Record<Role, Buffer>
export type ReadonlyAcceptancePlan = {
  schemaVersion: "m0-readonly-acceptance/1"
  runId: string
  keyId: string
  controllerDigest: string
  historicalControllerDigest: string
  untouchedUpdate9ControllerDigest: string
  bun: { path: string; digest: string }
  inputs: Record<Role, { path: string; digest: string }>
  sourceDigests: Record<string, string>
}

/** No process invocation, writes, metadata changes, database, or wall-clock override. */
export function protectedReadonlyBytes(path: string, maxBytes = 16 * 1024 * 1024) {
  if (!path.startsWith("/private/var/loopit/") || realpathSync(path) !== path) throw new Error("readonly_path_invalid")
  for (let part = path; ; part = dirname(part)) {
    const st = lstatSync(part)
    if (st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022)) throw new Error("readonly_input_unprotected")
    if (part === "/") break
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes) throw new Error("readonly_input_invalid")
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new Error("readonly_input_changed")
      offset += count
    }
    const after = fstatSync(fd), current = lstatSync(path)
    if (readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) || before.ino !== current.ino || before.dev !== current.dev ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        before.uid !== after.uid || before.mode !== after.mode || after.uid !== 0 || (after.mode & 0o022) || after.nlink !== 1)
      throw new Error("readonly_input_changed")
    return bytes
  } finally { closeSync(fd) }
}

/** Pure conformance seam: materials alone do not establish protected provenance. */
export function checkHistoricalAcceptance(raw: Raw, expectedIdentity: { runId: string; keyId: string }) {
  const read = (role: Role) => JSON.parse(raw[role].toString("utf8"))
  const goal = parse("goal", read("goal"))
  if (!goal.ok || checkFrozen(goal.value).length) throw new Error("readonly_goal_not_frozen")
  const result = read("result"), execution = read("execution"), budget = read("budget"), signed = read("signedCheck")
  const binding: Binding = {
    projectId: goal.value.projectId, taskId: goal.value.taskId, goalRevision: goal.value.goalRevision,
    runId: expectedIdentity.runId, goalDigest: digestOf(goal.value), sourceDigest: byteDigest(raw.source),
    acceptanceDigest: digestOf(goal.value.acceptance), criterionIds: ["M0-CODE-01"],
  }
  const dispatch = execution.dispatch
  if (result.status !== "passed" || result.run?.status !== "succeeded" || result.run?.runId !== binding.runId ||
      digestOf(result.binding) !== digestOf(binding) || digestOf(execution.binding) !== digestOf(binding) ||
      dispatch?.runId !== binding.runId || dispatch.taskId !== binding.taskId || dispatch.goalDigest !== binding.goalDigest ||
      dispatch.phase !== "started" || digestOf(dispatch.input?.executionBudget) !== digestOf(budget) ||
      dispatch.input?.spec.contextManifest.digest !== digestOf(dispatch.input?.context) ||
      budget.deadlineAt !== "2026-10-09T11:08:25.455Z" || budget.repairIndex !== 2 || budget.maxRepairs !== 3)
    throw new Error("readonly_historical_binding_invalid")
  return requireSignedFixtureAcceptance(signed, raw.evidence, raw.publicKey.toString("utf8"), {
    binding, candidateDigest: result.candidateDigest, keyId: expectedIdentity.keyId, testsDigest: byteDigest(raw.tests),
  }, { notBefore: dispatch.createdAt, deadlineAt: budget.deadlineAt })
}

export function runReadonlyAcceptance(planPath: string, controllerPath: string) {
  if (!/^\/private\/var\/loopit\/readonly-acceptance-[a-z0-9-]+\/plan\.json$/.test(planPath)) throw new Error("readonly_plan_path_invalid")
  const planBytes = protectedReadonlyBytes(planPath)
  const plan = JSON.parse(planBytes.toString("utf8")) as ReadonlyAcceptancePlan
  const roles = Object.keys(HISTORICAL_INPUTS) as Role[]
  if (plan.schemaVersion !== "m0-readonly-acceptance/1" ||
      plan.runId !== "run-46a51a51-d1ce-45f2-83f6-719cc4fc2bb8" ||
      plan.keyId !== "sha256:6c14767c3ec318cc893dee4ebed30231bf2b612ff276f7e59c1a3a00234cb7aa" ||
      Object.keys(plan.inputs).sort().join() !== roles.sort().join() ||
      controllerPath !== `${dirname(planPath)}/controller.mjs` || byteDigest(protectedReadonlyBytes(controllerPath)) !== plan.controllerDigest ||
      plan.bun.path !== `${HISTORICAL_JOB}/bin/bun` || realpathSync(process.execPath) !== plan.bun.path ||
      byteDigest(protectedReadonlyBytes(plan.bun.path, 128 * 1024 * 1024)) !== plan.bun.digest)
    throw new Error("readonly_plan_binding_invalid")
  const update9 = `${HISTORICAL_JOB}/bin/controller.mjs`
  if (byteDigest(protectedReadonlyBytes(update9)) !== plan.untouchedUpdate9ControllerDigest) throw new Error("readonly_update9_changed")
  const raw = {} as Raw
  for (const role of roles) {
    const pin = plan.inputs[role]
    if (pin.path !== HISTORICAL_INPUTS[role]) throw new Error("readonly_input_path_changed")
    raw[role] = protectedReadonlyBytes(pin.path)
    if (byteDigest(raw[role]) !== pin.digest) throw new Error("readonly_input_pin_changed")
  }
  const checkedAt = new Date().toISOString()
  let rejection: string | undefined
  try { checkHistoricalAcceptance(raw, plan) }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "evidence_acceptance_rejected:acceptance_deadline_exceeded") throw error
    rejection = error.message
  }
  if (!rejection) throw new Error("readonly_expired_evidence_unexpectedly_accepted")
  for (const role of roles) if (byteDigest(protectedReadonlyBytes(plan.inputs[role].path)) !== plan.inputs[role].digest) throw new Error("readonly_input_changed_after_check")
  if (byteDigest(protectedReadonlyBytes(update9)) !== plan.untouchedUpdate9ControllerDigest ||
      byteDigest(protectedReadonlyBytes(planPath)) !== byteDigest(planBytes)) throw new Error("readonly_trusted_input_changed_after_check")
  return {
    schemaVersion: "m0-readonly-acceptance-result/1", status: "rejected", rejection, checkedAt,
    runId: plan.runId, originalBudget: JSON.parse(raw.budget.toString("utf8")),
    planDigest: byteDigest(planBytes), controllerDigest: plan.controllerDigest,
    historicalControllerDigest: plan.historicalControllerDigest, untouchedUpdate9ControllerDigest: plan.untouchedUpdate9ControllerDigest,
    inputs: plan.inputs, sourceDigests: plan.sourceDigests,
    originalInputsUnchanged: true, update9Unchanged: true, update9FinalizerRerun: false,
    databaseOpened: false, modelCalls: 0, signingCalls: 0, subprocesses: 0, reservationReleased: false,
    clock: "actual-wall-clock-no-override", milestonePassed: false,
  }
}
