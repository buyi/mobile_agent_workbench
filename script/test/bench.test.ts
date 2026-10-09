import { afterEach, expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// Copy the actual CLI into a small isolated repository. Every invocation launches
// the real bench process and real Bun test runner; no verdict logic is mocked.
function fixture(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "loopit-bench-test-"))
  roots.push(root)
  for (const dir of ["script", "packages/delivery/test", "vendor/opencode", "node_modules/@opencode-ai/core"])
    mkdirSync(join(root, dir), { recursive: true })
  copyFileSync(join(import.meta.dir, "../bench.ts"), join(root, "script/bench.ts"))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, "packages/delivery/test", name), content)
  const out = join(root, "reports")
  const run = (...flags: string[]) => {
    const proc = Bun.spawnSync([process.execPath, "script/bench.ts", "verify", "--suite", "control-plane", "--out", out, ...flags], {
      cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state") },
    })
    const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"))
    for (const file of ["events.jsonl", "artifact-manifest.json", "metrics.json", "human-interventions.json", "runner.log"])
      expect(existsSync(join(out, file))).toBe(true)
    expect(proc.exitCode).toBe(result.exitCode)
    return { proc, result }
  }
  return { root, out, run }
}

const pass = 'import { test, expect } from "bun:test"; test("works", () => expect(1).toBe(1));'
const fail = 'import { test, expect } from "bun:test"; test("fails", () => expect(1).toBe(2));'
const loadError = 'throw new Error("fixture import failed");'

test("fresh passing assertions produce passed with a successful runner", () => {
  const { run, out } = fixture({ "pass.test.ts": pass })
  const { result } = run()
  expect(result).toMatchObject({ verdict: "passed", exitCode: 0, executorError: false, passed: 1, failed: 0, notRun: 0, runner: { exitCode: 0, signal: null } })
  const manifest = JSON.parse(readFileSync(join(out, "artifact-manifest.json"), "utf8"))
  expect(manifest.map((item: { path: string }) => item.path)).toContain("human-interventions.json")
})

test("assertion failures remain failed and are distinct from runner errors", () => {
  const { result } = fixture({ "fail.test.ts": fail }).run()
  expect(result).toMatchObject({ verdict: "failed", exitCode: 1, executorError: false, failed: 1 })
})

test("passing JUnit cannot hide a second file's top-level exception", () => {
  const { result } = fixture({ "pass.test.ts": pass, "load-error.test.ts": loadError }).run()
  expect(result).toMatchObject({ verdict: "blocked", exitCode: 3, executorError: true, passed: 1, runner: { exitCode: 1 } })
  expect(result.reason).toContain("unhandled error")
})

test("mixed assertion and import errors are an incomplete evaluation", () => {
  const { result } = fixture({ "fail.test.ts": fail, "load-error.test.ts": loadError }).run()
  expect(result).toMatchObject({ verdict: "blocked", exitCode: 3, executorError: true, failed: 1 })
})

test("a killed runner cannot reuse passing JUnit from the same --out", () => {
  const { root, out, run } = fixture({ "pass.test.ts": pass })
  expect(run().result.verdict).toBe("passed")
  writeFileSync(join(root, "packages/delivery/test/pass.test.ts"), 'process.kill(process.pid, "SIGTERM");')
  const { result } = run()
  expect(result).toMatchObject({ verdict: "blocked", exitCode: 3, executorError: true, sampleCount: 0 })
  expect(result.runner.signal).not.toBeNull()
  expect(existsSync(join(out, "junit.xml"))).toBe(false)
  const manifest = JSON.parse(readFileSync(join(out, "artifact-manifest.json"), "utf8"))
  expect(manifest.map((item: { path: string }) => item.path)).not.toContain("junit.xml")
})

test.each([0, 7])("early runner exit %i with no report is an executor error", (exitCode) => {
  const { result } = fixture({ "exit.test.ts": `process.exit(${exitCode});` }).run()
  expect(result).toMatchObject({ verdict: "blocked", exitCode: 3, executorError: true, runner: { exitCode } })
  expect(result.reason).toContain("no fresh junit")
})

test("skipped required cases are notRun and block suite completion", () => {
  const { result } = fixture({ "skip.test.ts": 'import { test } from "bun:test"; test.skip("unavailable device", () => {});' }).run()
  expect(result).toMatchObject({ verdict: "blocked", exitCode: 2, executorError: false, passed: 0, notRun: 1 })
})

test("zero tests never pass", () => {
  const { result } = fixture({ "empty.test.ts": 'export const empty = true;' }).run()
  expect(result).toMatchObject({ verdict: "blocked", exitCode: 2, executorError: false, sampleCount: 0 })
  expect(result.reason).toBe("no test cases ran")
})

test("blocked suite replaces earlier success and does not retain its JUnit", () => {
  const { out, run } = fixture({ "pass.test.ts": pass })
  expect(run().result.verdict).toBe("passed")
  expect(run("--suite", "device-contract").result).toMatchObject({ verdict: "blocked", exitCode: 2, executorError: false, sampleCount: 0 })
  expect(existsSync(join(out, "junit.xml"))).toBe(false)
})

test("missing setup produces a complete blocked report without loading contract dependencies", () => {
  const { root, run } = fixture()
  rmSync(join(root, "node_modules"), { recursive: true })
  expect(run("--suite", "contract-core").result).toMatchObject({ verdict: "blocked", exitCode: 2, executorError: false })
})

test("incorrect frozen dataset produces a complete blocked report", () => {
  const { result } = fixture().run("--suite", "contract-core", "--dataset", "unknown/99")
  expect(result).toMatchObject({ verdict: "blocked", exitCode: 2, executorError: false })
  expect(result.reason).toContain("frozen dataset")
})
