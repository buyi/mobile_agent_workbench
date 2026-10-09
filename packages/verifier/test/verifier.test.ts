import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import { canonicalJson, digestOf } from "../../contracts/src/digest"
import { parse } from "../../contracts/src/registry"
import { validateGate } from "../../contracts/src/gate"
import { acceptSignedFixtureCheck, byteDigest, openVerifier, parseRequest, verifyCandidate, verifySignedCheck, type VerifierConfig, type VerifyRequest } from "../src/service"
import { compilePureFixture } from "../src/pure-source"
import { captureProcess, fixtureSandbox, type CaseExecution } from "../src/sandbox"

const uid = process.getuid!()
const broken = 'export function sumEvenThrough(n: number): number {\n  if (!Number.isInteger(n) || n < 0 || n > 10000) throw new RangeError("n must be an integer from 0 through 10000");\n  let total = 0;\n  for (let value = 0; value < n; value += 2) total += value;\n  return total;\n}\n'
const correct = broken.replace("value < n", "value <= n")
let shared: string, runtime: string
const directories: string[] = []
beforeAll(() => {
  shared = realpathSync(mkdtempSync("/private/tmp/loopit-verifier-runtime-"))
  runtime = join(shared, "bun")
  copyFileSync(realpathSync(process.execPath), runtime); chmodSync(runtime, 0o500)
})
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
afterAll(() => rmSync(shared, { recursive: true, force: true }))

function fixture() {
  const root = realpathSync(mkdtempSync("/private/tmp/loopit-verifier-test-")); directories.push(root)
  for (const name of ["inbox", "work", "evidence"]) mkdirSync(join(root, name), { mode: 0o700 })
  const write = (name: string, value: string) => { const path = join(root, name); writeFileSync(path, value, { mode: 0o600 }); return path }
  const tests = write("cases.json", readFileSync(resolve(import.meta.dir, "../fixtures/cases.json"), "utf8"))
  const runner = write("runner.mjs", readFileSync(resolve(import.meta.dir, "../src/runner.mjs"), "utf8"))
  const source = write("source.ts", broken)
  const policy = write("policy.json", '{"purpose":"unit-test-only"}\n')
  const policyRef = `file://${policy}#${byteDigest(readFileSync(policy))}`
  const goal = { schemaVersion: "goal/1", projectId: "m0-fixture", taskId: "m0-code-fixture", goalRevision: 1,
    objective: "M0 pure-function verifier conformance fixture, not M1",
    scope: { repositoryRef: "fixture://sum-even-through", baseRevision: "test-fixture", allowedPaths: ["sumEvenThrough.ts"], excluded: [] },
    acceptance: [{ id: "M0-CODE-01", expected: "Pass the original 12 sumEvenThrough cases", verification: "executable", evidenceKinds: ["fixture-verification"], requiredAtStage: "verification" }],
    targetMatrix: [], delivery: { artifactKinds: ["candidate", "test-evidence"] }, policyRef,
    budgets: { wallMinutes: 1, maxRepairCycles: 0, maxParallelWriters: 1 }, costBudgetRef: policyRef }
  const goalPath = write("goal.json", JSON.stringify(goal))
  const { privateKey, publicKey } = generateKeyPairSync("ed25519") // ephemeral test identity, deleted after each test
  const keyPath = write("ephemeral-test-key.pem", privateKey.export({ type: "pkcs8", format: "pem" }).toString())
  const pinned = (path: string) => ({ path, digest: byteDigest(readFileSync(path)) })
  const config: VerifierConfig = { schemaVersion: "m0-verifier-config/1", verifierId: "loopit-signer", signerUid: uid, builderUid: uid,
    inboxRoot: join(root, "inbox"), workRoot: join(root, "work"), evidenceRoot: join(root, "evidence"),
    runtime: pinned(runtime), runner: pinned(runner), tests: pinned(tests), source: pinned(source), goal: pinned(goalPath),
    privateKeyPath: keyPath, keyId: byteDigest(publicKey.export({ type: "spki", format: "der" })),
    binding: { projectId: goal.projectId, taskId: goal.taskId, goalRevision: 1, runId: "run-1", goalDigest: digestOf(goal),
      sourceDigest: byteDigest(broken), acceptanceDigest: digestOf(goal.acceptance), criterionIds: ["M0-CODE-01"] } }
  const configPath = write("config.json", JSON.stringify(config))
  const request = (content = correct): VerifyRequest => {
    const name = `${randomUUID()}.ts`
    writeFileSync(join(config.inboxRoot, name), content, { mode: 0o600 })
    return { schemaVersion: "verify-candidate-request/1", requestId: randomUUID(), candidateFile: name,
      candidateDigest: byteDigest(content), binding: structuredClone(config.binding) }
  }
  return { root, config, configPath, request, goal, publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    expected: (candidateDigest: string) => ({ binding: config.binding, candidateDigest, keyId: config.keyId, testsDigest: config.tests.digest }) }
}

// Real child/VM execution without Seatbelt is strictly a library test seam. Its
// report says unverified-test-seam, and the key is ephemeral. CLI cannot select it.
const childForUnitTest = (input: CaseExecution) => captureProcess(input.runtime, [input.runner, input.compiled], input.scratch, input.request, input.timeoutMs)

test("known good executes 12 real child observations, persists evidence, then signs a bound Gate", async () => {
  const f = fixture(), request = f.request()
  const result = await verifyCandidate(openVerifier(f.configPath, uid), request, childForUnitTest)
  expect(result.status).toBe("passed")
  expect(result.signedCheck).toBeDefined()
  const signed = result.signedCheck!
  expect(verifySignedCheck(signed, f.publicPem, f.expected(request.candidateDigest))).toBe(true)
  const evidence = readFileSync(join(f.config.evidenceRoot, request.requestId, "evidence.json"))
  expect(byteDigest(evidence)).toBe(signed.payload.evidence.digest)
  const report = JSON.parse(evidence.toString())
  expect(report.observations).toHaveLength(12)
  expect(report.observations.every((item: { matched: boolean }) => item.matched)).toBe(true)
  expect(report.isolation.network).toBe("unverified-test-seam")
  const gate = parse("gate", signed.payload.gate), goal = parse("goal", f.goal)
  expect(gate.ok && goal.ok && validateGate(gate.value, goal.value)).toEqual([])
  expect(signed.payload.gate.scope).toBe("delivery")
  expect(signed.payload.gate.verifier.id).toBe("loopit-signer")
  expect(existsSync(join(f.config.evidenceRoot, request.requestId, "signed-check.json"))).toBe(true)
  const window = { notBefore: new Date(Date.parse(report.startedAt) - 1).toISOString(),
    deadlineAt: new Date(Date.parse(report.finishedAt) + 60_000).toISOString() }
  const accept = (value: unknown = signed, raw: Buffer | undefined = evidence, clock = window, expected = f.expected(request.candidateDigest)) =>
    acceptSignedFixtureCheck(value, raw, f.publicPem, expected, clock)
  expect(accept()).toEqual({ accepted: true, reason: "accepted" })
  expect(accept(signed, evidence, { ...window, now: Date.parse(window.deadlineAt) } as typeof window).accepted).toBe(true)
  expect(accept(signed, evidence, { ...window, now: Date.parse(window.deadlineAt) + 1 } as typeof window).reason).toBe("acceptance_deadline_exceeded")
  expect(accept(signed, evidence, { ...window, deadlineAt: new Date(Date.parse(report.finishedAt) - 1).toISOString() }).reason).toBe("acceptance_deadline_exceeded")
  expect(accept(signed, evidence, { ...window, now: Date.parse(report.finishedAt) - 1 } as typeof window).reason).toBe("evidence_from_future")
  expect(accept(signed, evidence, { ...window, notBefore: new Date(Date.parse(report.startedAt) + 1).toISOString() }).reason).toBe("evidence_before_run")
  expect(accept(signed, evidence, { ...window, deadlineAt: "invalid" }).reason).toBe("acceptance_clock_invalid")
  expect(accept(null).reason).toBe("signature_or_binding_invalid")
  expect(acceptSignedFixtureCheck(signed, undefined, f.publicPem, f.expected(request.candidateDigest), window).reason).toBe("evidence_missing_or_digest_invalid")
  expect(accept(signed, Buffer.concat([evidence, Buffer.from("\n")])).reason).toBe("evidence_missing_or_digest_invalid")
  expect(accept({ ...signed, signature: "broken" }).reason).toBe("signature_or_binding_invalid")
  expect(accept(signed, evidence, window, { ...f.expected(request.candidateDigest), binding: { ...f.config.binding, runId: "other-run" } }).reason).toBe("signature_or_binding_invalid")
  // Acceptance never mutates/re-signs the actual artifact; pure verification
  // remains valid independently of the caller's elapsed acceptance deadline.
  expect(verifySignedCheck(signed, f.publicPem, f.expected(request.candidateDigest))).toBe(true)
}, 20000)

test("known broken candidate fails real parent comparisons and receives no signature", async () => {
  const f = fixture(), request = f.request(broken)
  const result = await verifyCandidate(openVerifier(f.configPath, uid), request, childForUnitTest)
  expect(result.status).toBe("failed")
  expect(result.signedCheck).toBeUndefined()
  const report = JSON.parse(readFileSync(join(f.config.evidenceRoot, request.requestId, "evidence.json"), "utf8"))
  expect(report.observations).toHaveLength(12)
  expect(report.observations.filter((item: { matched: boolean }) => !item.matched).length).toBeGreaterThan(0)
  expect(existsSync(join(f.config.evidenceRoot, request.requestId, "signed-check.json"))).toBe(false)
}, 20000)

test("missing, wrong digest and final symlink candidates are refused before dispatch", async () => {
  const f = fixture(), loaded = openVerifier(f.configPath, uid)
  const missing = f.request(); rmSync(join(f.config.inboxRoot, missing.candidateFile))
  let dispatched = 0
  const executor = async (value: CaseExecution) => { dispatched++; return childForUnitTest(value) }
  await expect(verifyCandidate(loaded, missing, executor)).rejects.toThrow()
  const altered = f.request(); writeFileSync(join(f.config.inboxRoot, altered.candidateFile), broken)
  await expect(verifyCandidate(loaded, altered, executor)).rejects.toThrow("candidate_digest_mismatch")
  const link = f.request(); rmSync(join(f.config.inboxRoot, link.candidateFile)); symlinkSync(f.config.source.path, join(f.config.inboxRoot, link.candidateFile))
  await expect(verifyCandidate(loaded, link, executor)).rejects.toThrow()
  expect(dispatched).toBe(0)
})

test("request cannot replace goal, run, source, acceptance, test runner or trust root", async () => {
  const f = fixture(), loaded = openVerifier(f.configPath, uid)
  for (const field of ["goalDigest", "runId", "sourceDigest", "acceptanceDigest"] as const) {
    const request = f.request(); request.binding[field] = field === "runId" ? "other-run" : byteDigest("other")
    await expect(verifyCandidate(loaded, request, childForUnitTest)).rejects.toThrow("request_binding_mismatch")
  }
  for (const field of ["publicKey", "tests", "runner", "configPath"]) expect(() => parseRequest({ ...f.request(), [field]: "builder" })).toThrow("invalid_fields")
})

test("real nonzero exit and SIGKILL after a success observation cannot receive a signature", async () => {
  for (const suffix of ['process.exitCode = 2;', 'await Bun.sleep(5); process.kill(process.pid, "SIGKILL");']) {
    const f = fixture(), request = f.request()
    writeFileSync(f.config.runner.path, readFileSync(f.config.runner.path, "utf8") + suffix + "\n")
    f.config.runner.digest = byteDigest(readFileSync(f.config.runner.path)); writeFileSync(f.configPath, JSON.stringify(f.config))
    let calls = 0
    const result = await verifyCandidate(openVerifier(f.configPath, uid), request, (input) => { calls++; return childForUnitTest(input) })
    expect(result.status).toBe("failed"); expect(result.signedCheck).toBeUndefined(); expect(calls).toBe(1)
    const report = JSON.parse(readFileSync(join(f.config.evidenceRoot, request.requestId, "evidence.json"), "utf8"))
    expect(JSON.parse(report.observations[0].stdout).observation).toEqual({ kind: "returned", value: 0 })
    expect(report.observations[0].process.code !== 0 || report.observations[0].process.signal !== null).toBe(true)
  }
})

test("real stdout flooding and an unresponsive runner are bounded and unsigned", async () => {
  for (const body of ['process.stdout.write("x".repeat(32768));', 'await new Promise(() => {});']) {
    const f = fixture(), request = f.request()
    writeFileSync(f.config.runner.path, body); f.config.runner.digest = byteDigest(readFileSync(f.config.runner.path))
    writeFileSync(f.configPath, JSON.stringify(f.config))
    const result = await verifyCandidate(openVerifier(f.configPath, uid), request, (input) => childForUnitTest({ ...input, timeoutMs: 100 }))
    expect(result.status).toBe("failed"); expect(result.signedCheck).toBeUndefined()
    const report = JSON.parse(readFileSync(join(f.config.evidenceRoot, request.requestId, "evidence.json"), "utf8"))
    expect(report.observations[0].process.overflow || report.observations[0].process.timedOut).toBe(true)
  }
})

test("wrong nonce and output overflow fail closed", async () => {
  for (const mode of ["nonce", "overflow"] as const) {
    const f = fixture(), request = f.request()
    const result = await verifyCandidate(openVerifier(f.configPath, uid), request, async (input) => {
      const output = await childForUnitTest(input)
      if (mode === "overflow") return { ...output, overflow: true }
      const observation = JSON.parse(output.stdout); observation.nonce = randomUUID()
      return { ...output, stdout: JSON.stringify(observation) }
    })
    expect(result.status).toBe("failed"); expect(result.signedCheck).toBeUndefined()
  }
})

test("changed protected tests or candidate snapshot prevent signing", async () => {
  for (const target of ["tests", "candidate"] as const) {
    const f = fixture(), request = f.request()
    let first = true
    const result = await verifyCandidate(openVerifier(f.configPath, uid), request, async (input) => {
      const output = await childForUnitTest(input)
      if (first) {
        first = false
        const path = target === "tests" ? f.config.tests.path : input.compiled
        chmodSync(path, 0o600); writeFileSync(path, readFileSync(path, "utf8") + "\n")
      }
      return output
    })
    expect(result.status).toBe("failed"); expect(result.signedCheck).toBeUndefined()
  }
}, 20000)

test("fixed expected cases cannot be weakened even by updating the file pin", () => {
  const f = fixture(); const cases = JSON.parse(readFileSync(f.config.tests.path, "utf8"))
  cases.cases[7].expected.value = 0
  writeFileSync(f.config.tests.path, JSON.stringify(cases)); f.config.tests.digest = byteDigest(readFileSync(f.config.tests.path))
  writeFileSync(f.configPath, JSON.stringify(f.config))
  expect(() => openVerifier(f.configPath, uid)).toThrow("fixed_fixture_changed")
})

test("signed payload tampering, another candidate and another trust key are rejected", async () => {
  const f = fixture(), request = f.request()
  const result = await verifyCandidate(openVerifier(f.configPath, uid), request, childForUnitTest)
  const signed = result.signedCheck!
  expect(verifySignedCheck({ ...signed, payload: { ...signed.payload, testsPassed: 11 } }, f.publicPem, f.expected(request.candidateDigest))).toBe(false)
  expect(verifySignedCheck(signed, f.publicPem, f.expected(byteDigest("other candidate")))).toBe(false)
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()
  expect(verifySignedCheck(signed, other, f.expected(request.candidateDigest))).toBe(false)
  const gateChanged = { ...signed, payload: { ...signed.payload, gate: { ...signed.payload.gate, verdict: "failed" } } }
  expect(verifySignedCheck(gateChanged, f.publicPem, f.expected(request.candidateDigest))).toBe(false)
}, 20000)

test("an existing request directory is never overwritten or automatically retried", async () => {
  const f = fixture(), request = f.request(), loaded = openVerifier(f.configPath, uid)
  mkdirSync(join(f.config.evidenceRoot, request.requestId), { mode: 0o700 })
  let dispatched = 0
  await expect(verifyCandidate(loaded, request, async (input) => { dispatched++; return childForUnitTest(input) })).rejects.toThrow()
  expect(dispatched).toBe(0)
})

test("candidate grammar refuses process/transport access and supports the original fixture", () => {
  expect(compilePureFixture(correct)).toContain("function sumEvenThrough")
  for (const candidate of [
    'process.stdout.write("passed");' + correct,
    'export function sumEvenThrough(n: number) { return Bun.spawnSync(["/bin/sh"]).exitCode; }',
    'export function sumEvenThrough(n: number) { return Number.constructor("return process")(); }',
    'export function sumEvenThrough(n: number) { return n["constructor"]["constructor"]("return process")(); }',
    'export function sumEvenThrough(n: number) { let Number = n; return Number.isInteger(n); }',
  ]) expect(() => compilePureFixture(candidate)).toThrow()
})

test("production sandbox grants no network/fork/key/test access and only the fixed executable", () => {
  const f = fixture(), compiled = join(f.config.workRoot, "candidate.js")
  writeFileSync(compiled, compilePureFixture(correct), { mode: 0o400 })
  const profile = fixtureSandbox({ runtime, runner: f.config.runner.path, compiled, scratch: f.config.workRoot, request: {}, timeoutMs: 1000 })
  expect(profile.text).not.toContain("allow network")
  expect(profile.text).not.toContain("allow process-fork")
  expect(profile.text).toContain('(allow process-exec (literal (param "RUNTIME")))')
  expect(canonicalJson(profile.params)).not.toContain(f.config.privateKeyPath)
  expect(canonicalJson(profile.params)).not.toContain(f.config.tests.path)
})
