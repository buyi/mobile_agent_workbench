import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { checkHistoricalAcceptance, HISTORICAL_INPUTS, protectedReadonlyBytes, requireSignedFixtureAcceptance } from "../m0/control-loop-acceptance"
import { acceptSignedFixtureCheck, byteDigest, verifySignedCheck } from "../../packages/verifier/src/service"
import { originalSignedCheckPin } from "../m0/readonly-acceptance-inputs"

test("read-only acceptance never accepts unprotected caller paths or invalid signatures", () => {
  expect(() => protectedReadonlyBytes("/tmp/plan.json")).toThrow("readonly_path_invalid")
  const window = { notBefore: "2026-01-01T00:00:00Z", deadlineAt: "2026-01-02T00:00:00Z" }
  const prior = acceptSignedFixtureCheck({}, Buffer.from("{}"), "invalid", {} as any, window)
  expect(prior).toEqual({ accepted: false, reason: "signature_or_binding_invalid" })
  expect(() => requireSignedFixtureAcceptance({}, Buffer.from("{}"), "invalid", {} as any, window)).toThrow(`evidence_acceptance_rejected:${prior.reason}`)
})

test("bundled controller read-only rejection returns before database/global path initialization", () => {
  const directory = mkdtempSync("/private/tmp/loopit-readonly-import-")
  try {
    const bundled = join(directory, "controller.mjs")
    // Use the same standalone Bun build context as the deployment stager; the
    // test runner's already-loaded resolver cache must not determine the bundle.
    const build = spawnSync(process.execPath, ["--eval", `const b = await Bun.build({entrypoints:[${JSON.stringify(join(import.meta.dir, "../m0/control-loop.ts"))}],target:"bun",format:"esm",packages:"bundle",splitting:false,sourcemap:"none"}); if(!b.success || b.outputs.length!==1) throw Error("bundle failed"); await Bun.write(${JSON.stringify(bundled)}, b.outputs[0]);`], {
      timeout: 20000, encoding: "utf8", env: { PATH: "/usr/bin:/bin", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    })
    expect(build.status).toBe(0)
    expect(build.stderr).toBe("")
    const source = `const realUid = process.getuid(); const {main} = await import(${JSON.stringify(bundled)});
// Test seam only: no identity syscall. The invalid plan is rejected before any file read.
process.getuid = () => 0; process.geteuid = () => 0;
process.argv = [process.execPath, "fixture", "--phase", "readonly-acceptance", "--plan", "/tmp/not-trusted.json"];
try { await main(); throw Error("unexpected_success"); } catch (error) { if(error.message !== "readonly_plan_path_invalid") throw error; }
console.log(JSON.stringify({realUid, branch:"readonly_plan_path_invalid"}));`
    const child = spawnSync(process.execPath, ["--eval", source], { timeout: 10000, encoding: "utf8", env: {
      PATH: "/usr/bin:/bin", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", HOME: join(directory, "home"), XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"), XDG_DATA_HOME: join(directory, "data"), XDG_STATE_HOME: join(directory, "state"),
    } })
    expect(child.status).toBe(0)
    expect(child.stderr).toBe("")
    expect(JSON.parse(child.stdout)).toEqual({ realUid: process.getuid!(), branch: "readonly_plan_path_invalid" })
    for (const path of ["home", "config", "cache", "data", "state"]) expect(existsSync(join(directory, path))).toBe(false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

// Opt-in historical evidence, never a same-user signing key or a new model run.
const archive = process.env.LOOPIT_ACCEPTANCE_ARCHIVE
const actual = archive ? test : test.skip
function fixture() {
  const names = { goal: "goal.json", source: "source.ts", tests: "tests.json", publicKey: "publicKey.pem", signedCheck: "signedCheck.json", evidence: "evidence.json", result: "result.json", execution: "execution.json", budget: "runBudget.json" }
  const raw = Object.fromEntries(Object.keys(HISTORICAL_INPUTS).map(role => [role, readFileSync(join(archive!, names[role as keyof typeof names]))])) as Parameters<typeof checkHistoricalAcceptance>[0]
  const result = JSON.parse(raw.result.toString()), signed = JSON.parse(raw.signedCheck.toString())
  const identity = { runId: result.run.runId, keyId: signed.payload.keyId }
  return { raw, result, signed, identity }
}
actual("actual signed bytes remain cryptographically valid but the real elapsed deadline rejects", () => {
  const f = fixture(), before = Object.fromEntries(Object.entries(f.raw).map(([k, v]) => [k, byteDigest(v)]))
  const expected = { binding: f.result.binding, candidateDigest: f.result.candidateDigest, keyId: f.identity.keyId, testsDigest: byteDigest(f.raw.tests) }
  expect(verifySignedCheck(f.signed, f.raw.publicKey.toString(), expected)).toBe(true)
  expect(() => checkHistoricalAcceptance(f.raw, f.identity)).toThrow("evidence_acceptance_rejected:acceptance_deadline_exceeded")
  expect(Object.fromEntries(Object.entries(f.raw).map(([k, v]) => [k, byteDigest(v)]))).toEqual(before)
})
actual("an extra caller now cannot replay the controller wrapper into the old valid window", () => {
  const f = fixture(), execution = JSON.parse(f.raw.execution.toString()), budget = JSON.parse(f.raw.budget.toString())
  const window = { notBefore: execution.dispatch.createdAt, deadlineAt: budget.deadlineAt, now: f.signed.payload.observedAt }
  expect(() => requireSignedFixtureAcceptance(f.signed, f.raw.evidence, f.raw.publicKey.toString(), { binding: f.result.binding, candidateDigest: f.result.candidateDigest, keyId: f.identity.keyId, testsDigest: byteDigest(f.raw.tests) }, window)).toThrow("evidence_acceptance_rejected:acceptance_deadline_exceeded")
})
actual("wrong Run and renewed budget fail before temporal acceptance", () => {
  const f = fixture()
  expect(() => checkHistoricalAcceptance(f.raw, { ...f.identity, runId: "different" })).toThrow("readonly_historical_binding_invalid")
  const budget = JSON.parse(f.raw.budget.toString())
  budget.deadlineAt = new Date(Date.now() + 3600000).toISOString()
  expect(() => checkHistoricalAcceptance({ ...f.raw, budget: Buffer.from(JSON.stringify(budget)) }, f.identity)).toThrow("readonly_historical_binding_invalid")
})
actual("corrupt evidence or signature cannot masquerade as the expected expired rejection", () => {
  const f = fixture()
  expect(() => checkHistoricalAcceptance({ ...f.raw, evidence: Buffer.concat([f.raw.evidence, Buffer.from(" ")]) }, f.identity)).toThrow("evidence_acceptance_rejected:evidence_missing_or_digest_invalid")
  f.signed.signature = "invalid"
  expect(() => checkHistoricalAcceptance({ ...f.raw, signedCheck: Buffer.from(JSON.stringify(f.signed)) }, f.identity)).toThrow("evidence_acceptance_rejected:signature_or_binding_invalid")
})
actual("reserialized public signature export cannot substitute its digest for original protected report bytes", () => {
  const f = fixture()
  const original = readFileSync(join(import.meta.dir, "../../.bench/m0-fixes/control-loop-actual/code-task-passed/reports/signed-check.json"))
  const originalDigest = "sha256:f19125bc50b68d47f470a1820b120996ee885626395198e1cd47ff2926a0e9c4"
  const exportDigest = byteDigest(f.raw.signedCheck)
  const expected = { binding: f.result.binding, candidateDigest: f.result.candidateDigest, keyId: f.identity.keyId, testsDigest: byteDigest(f.raw.tests) }
  expect(originalDigest).not.toBe(exportDigest)
  expect(originalSignedCheckPin(original, f.raw.signedCheck, originalDigest, exportDigest, f.raw.publicKey.toString(), expected)).toEqual({ originalDigest, exportDigest, sameSignedPayload: true, signatureVerified: true })
  expect(() => originalSignedCheckPin(original, f.raw.signedCheck, exportDigest, exportDigest, f.raw.publicKey.toString(), expected)).toThrow("signed_check_source_bytes_changed")
  const changed = Buffer.from(JSON.stringify({ ...f.signed, signature: "changed" }))
  expect(() => originalSignedCheckPin(original, changed, originalDigest, byteDigest(changed), f.raw.publicKey.toString(), expected)).toThrow("signed_check_export_semantics_changed")
  expect(() => originalSignedCheckPin(original, f.raw.signedCheck, originalDigest, exportDigest, f.raw.publicKey.toString(), { ...expected, binding: { ...expected.binding, runId: "wrong" } })).toThrow("signed_check_source_signature_invalid")
})
