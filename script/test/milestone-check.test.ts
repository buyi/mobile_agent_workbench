import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { milestoneCheck } from "../m0/milestone-check"

const dirs: string[] = []
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }) })
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "m0-cli-")); dirs.push(root); return root }
const hash = (path: string) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`
const root = join(import.meta.dir, "../..")
const run = (args: string[]) => spawnSync(process.execPath, [join(import.meta.dir, "../bench.ts"), "milestone", "check", "--milestone", "M0", ...args],
  { cwd: root, timeout: 5000, encoding: "utf8" })

test("real milestone CLI persists blocked evidence and cannot self-enable signer independence", () => {
  const out = join(temporary(), "report")
  const result = run(["--out", out, "--independent-verifier-established", "true"])
  expect(result.status).toBe(2)
  const report = JSON.parse(readFileSync(join(out, "result.json"), "utf8"))
  expect(report.verdict).toBe("blocked")
  expect(report.signatureVerified).toBe(false)
  expect(report.independentVerifierEstablished).toBe(false)
  expect(report.cases).toHaveLength(15)
  expect(report.cases.every((item: { outcome: string }) => item.outcome === "notRun")).toBe(true)
  expect(report.issues.map((item: { code: string }) => item.code)).toContain("verifier_boundary_unverified")
  for (const name of ["artifact-manifest.json", "metrics.json", "events.jsonl", "human-interventions.json"])
    expect(existsSync(join(out, name))).toBe(true)
})

test("output cannot overwrite signed artifacts, enter their root through aliases, or reuse a prior report", () => {
  const directory = temporary(), evidence = join(directory, "evidence"), alias = join(directory, "alias")
  mkdirSync(evidence)
  const metrics = join(evidence, "metrics.json"), attestation = join(evidence, "attestation.json")
  writeFileSync(metrics, JSON.stringify({ observedCost: "unknown", marker: "original evidence bytes" }))
  const payload = JSON.stringify({ artifacts: [{ ref: "artifact://metrics", path: "metrics.json", digest: hash(metrics) }] })
  const { privateKey } = generateKeyPairSync("ed25519")
  writeFileSync(attestation, JSON.stringify({ payload, signature: sign(null, Buffer.from(payload), privateKey).toString("base64") }))
  symlinkSync(evidence, alias)
  const original = [hash(metrics), hash(attestation)]
  for (const out of [evidence, join(evidence, "new-report"), join(alias, "new-report")]) {
    const result = run(["--attestation", attestation, "--out", out])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("new directory separate")
    expect([hash(metrics), hash(attestation)]).toEqual(original)
    expect(existsSync(join(evidence, "new-report"))).toBe(false)
  }
  const out = join(directory, "separate-report")
  const first = run(["--attestation", attestation, "--out", out])
  expect(first.status).not.toBe(0)
  expect(existsSync(join(out, "result.json"))).toBe(true)
  const priorReport = hash(join(out, "result.json"))
  const rerun = run(["--attestation", attestation, "--out", out])
  expect(rerun.status).toBe(2)
  expect(rerun.stderr).toContain("new directory separate")
  expect(hash(join(out, "result.json"))).toBe(priorReport)
  expect([hash(metrics), hash(attestation)]).toEqual(original)
})

test("the CLI passes operator cost-policy bytes and trusted dirty state into the checker", async () => {
  const directory = temporary(), out = join(directory, "report"), policy = join(directory, "cost-policy.json")
  writeFileSync(policy, JSON.stringify({ schemaVersion: "cost-policy/1", allowUnknownCost: true }))
  const code = await milestoneCheck({ milestone: "M0", out, "cost-policy": policy }, {
    root, environment: { sourceRevision: "1".repeat(40), dirty: true },
  })
  expect(code).toBe(2)
  const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"))
  expect(result.costPolicyDigest).toBe(hash(policy))
  expect(result.issues.map((item: { code: string }) => item.code)).toContain("source_dirty")
  expect(result.independentVerifierEstablished).toBe(false)
})

test("a submitted deployment manifest cannot supply its own trust or mark any of the 15 cases passed", () => {
  const directory = temporary(), candidate = join(directory, "deployment.json"), out = join(temporary(), "report")
  writeFileSync(candidate, JSON.stringify({ schemaVersion: "m0-verifier-deployment-export/1", independentVerifierEstablished: true,
    trust: { publicKeyPem: "self asserted" }, files: [] }))
  const result = run(["--verifier-deployment", candidate, "--independent-verifier-established", "true", "--out", out])
  expect(result.status).toBe(2)
  const report = JSON.parse(readFileSync(join(out, "result.json"), "utf8"))
  expect(report.verifierDeployment.established).toBe(false)
  expect(report.independentVerifierEstablished).toBe(false)
  expect(report.cases).toHaveLength(15)
  expect(report.cases.every((x: { outcome: string }) => x.outcome === "notRun")).toBe(true)
})
