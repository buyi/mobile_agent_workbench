// Frozen evaluation entry (acceptance-spec.md §7, M0 §7):
//   bun script/bench.ts verify --suite <suite> [--dataset <id>] [--out <dir>]
//   bun script/bench.ts milestone check --milestone M0 --manifest <file>
// Each run writes result.json, events.jsonl, artifact-manifest.json, metrics.json and
// human-interventions.json. Exit codes: 0 passed, 1 assertion failed, 2 environment
// blocked / not runnable, 3 executor error. notRun is never reported as passed.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = join(import.meta.dir, "..")

interface Suite {
  readonly tests?: string
  readonly dataset?: { readonly id: string; readonly digest: () => Promise<string> }
  readonly blocked?: string
}

const suites: Record<string, Suite> = {
  "contract-core": {
    tests: "./packages/contracts/test",
    // Load only after checking setup; a missing dependency must produce a blocked report.
    dataset: { id: "contract-core/1", digest: async () => (await import("../packages/contracts/test/fixtures")).datasetDigest() },
  },
  "control-plane": { tests: "./packages/delivery/test" },
  "runtime-local": { tests: "./packages/runtime/test" },
  "recovery-journal-local": { tests: "./packages/recovery-journal/test" },
  "sandbox-contract":
    process.platform === "darwin"
      ? { tests: "./packages/sandbox/test" }
      : { blocked: "Seatbelt conformance requires a macOS host (run as loopit-worker, see script/macos/setup-worker.sh)" },
  "runtime-contract": { blocked: "M0-T03 suite aggregation is not implemented: separate deployed reports prove bounded OpenCode delivery, Supervisor UID/process-tree stop, A05 controls and A06 unknown-owner rejection; see docs/m0/control-matrix.md and docs/m0/owner-loss.md. They do not establish general automatic recovery of unknown execution" },
  "device-contract": { blocked: "M0-T04 incomplete: operator UI probes and a local durable Broker install/reconcile experiment are recorded; OS-exclusive device ownership/revocation and channel binding to a formal Run/Gate remain unverified" },
  recovery: { blocked: "M0-T05/T07 incomplete: local ledger, separate-process journal and bounded deployed stop/replay/reconcile cases are covered; independent failure-domain authority and OS-exclusive device side-effect control are not established" },
  "autonomy-e2e": { blocked: "M1 suite: requires a frozen M1 GoalSpec" },
  "daily-scenarios": { blocked: "M2 suite" },
  "self-improvement": { blocked: "M3 suite" },
}

function args() {
  const argv = process.argv.slice(2)
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i]
  return { command: argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--")).join(" "), flags }
}

const git = (cmd: string[], cwd = root) => {
  const out = Bun.spawnSync(["git", ...cmd], { cwd })
  return out.exitCode === 0 ? out.stdout.toString().trim() : "unknown"
}

function environment() {
  return {
    sourceRevision: git(["rev-parse", "HEAD"]),
    dirty: git(["status", "--porcelain"]) !== "",
    opencode: git(["rev-parse", "HEAD"], join(root, "vendor/opencode")),
    bun: Bun.version,
    platform: `${process.platform}-${process.arch}`,
  }
}

function write(out: string, files: Record<string, unknown>) {
  mkdirSync(out, { recursive: true })
  for (const [name, value] of Object.entries(files))
    writeFileSync(join(out, name), typeof value === "string" ? value : JSON.stringify(value, null, 2))
}

function parseJunit(xml: string) {
  // Bun's version is pinned. Require its complete report and reconcile its totals
  // instead of treating any fragments containing passing testcases as evidence.
  const header = /<testsuites\b([^>]*)>/.exec(xml)?.[1]
  if (!header || !xml.trimEnd().endsWith("</testsuites>")) throw new Error("incomplete junit report")
  const cases = [...xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)].map((m) => {
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(m[1])?.[1] ?? ""
    const body = m[3] ?? ""
    const outcome = /<failure\b|<error\b/.test(body) ? "failed" : /<skipped\b/.test(body) ? "notRun" : "passed"
    return { name: attr("name"), classname: attr("classname"), file: attr("file"), seconds: Number(attr("time") || 0), outcome }
  })
  const total = (name: string) => Number(new RegExp(`\\b${name}="(\\d+)"`).exec(header)?.[1] ?? NaN)
  if (total("tests") !== cases.length || cases.some((c) => !Number.isFinite(c.seconds)))
    throw new Error("junit case count or timing is invalid")
  if (total("failures") !== cases.filter((c) => c.outcome === "failed").length ||
      total("skipped") !== cases.filter((c) => c.outcome === "notRun").length)
    throw new Error("junit outcome totals are inconsistent")
  if (/<error\b/.test(xml) || (Number.isFinite(total("errors")) && total("errors") > 0))
    throw new Error("junit reports a runner error")
  return cases
}

type Cases = ReturnType<typeof parseJunit>
const reportFiles = ["junit.xml", "runner.log", "result.json", "events.jsonl", "artifact-manifest.json", "metrics.json", "human-interventions.json"]

async function verify(suiteName: string, flags: Record<string, string>) {
  const suite = suites[suiteName]
  const started = new Date()
  const out = resolve(flags.out ?? join(root, ".bench", suiteName, started.toISOString().replace(/[:.]/g, "-")))
  mkdirSync(out, { recursive: true })
  // --out can be reused. Never accept a report or keep a success from an earlier run.
  for (const file of reportFiles) rmSync(join(out, file), { force: true })
  const base = { suite: suiteName, startedAt: started.toISOString(), environment: environment() }
  let dataset: { id: string; digest: string } | undefined
  let cases: Cases = []
  let log = ""
  let runner: { exitCode: number | null; signal: string | number | null } | undefined

  function finish(exitCode: number, reason?: string) {
    const count = (o: string) => cases.filter((c) => c.outcome === o).length
    const verdict = exitCode === 0 ? "passed" : exitCode === 1 ? "failed" : "blocked"
    const finished = new Date()
    write(out, {
      "runner.log": log,
      "result.json": {
        ...base, finishedAt: finished.toISOString(), dataset, verdict, reason, exitCode,
        executorError: exitCode === 3, runner, sampleCount: cases.length,
        passed: count("passed"), failed: count("failed"), blocked: 0, notRun: count("notRun"), cases,
      },
      "events.jsonl": [...cases.map((c) => JSON.stringify({ type: "case.finished", ...c })),
        JSON.stringify({ type: "suite.finished", verdict, exitCode, reason })].join("\n") + "\n",
      "metrics.json": { durationMs: finished.getTime() - started.getTime(), caseSeconds: cases.reduce((s, c) => s + c.seconds, 0) },
      // Suites run unattended; any manual step during a run must be appended here by the operator tooling.
      "human-interventions.json": [],
    })
    write(out, {
      "artifact-manifest.json": reportFiles.filter((file) => file !== "artifact-manifest.json" && existsSync(join(out, file))).map((file) => ({
        path: file, digest: `sha256:${createHash("sha256").update(readFileSync(join(out, file))).digest("hex")}`,
      })),
    })
    console.log(`${suiteName}: ${verdict} (${count("passed")} passed, ${count("failed")} failed, ${count("notRun")} notRun)${reason ? `: ${reason}` : ""}\n${out}`)
    return exitCode
  }

  if (!suite || suite.blocked)
    return finish(2, suite?.blocked ?? `unknown suite ${suiteName}; known: ${Object.keys(suites).join(", ")}`)
  if (flags.dataset && flags.dataset !== suite.dataset?.id)
    return finish(2, `dataset ${flags.dataset} is not the frozen dataset ${suite.dataset?.id ?? "(none)"}`)
  if (!existsSync(join(root, "node_modules/@opencode-ai/core")))
    return finish(2, "environment not set up: run `bun install --frozen-lockfile` in vendor/opencode, then `bun script/setup.ts`")

  const junit = join(out, "junit.xml")
  try {
    if (suite.dataset) dataset = { id: suite.dataset.id, digest: await suite.dataset.digest() }
    const proc = Bun.spawnSync([process.execPath, "test", suite.tests!, "--reporter=junit", `--reporter-outfile=${junit}`], {
      cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    })
    log = proc.stdout.toString() + proc.stderr.toString()
    runner = { exitCode: proc.exitCode, signal: proc.signalCode ?? null }
    if (existsSync(junit)) cases = parseJunit(readFileSync(junit, "utf8"))
    if (proc.signalCode) return finish(3, `test runner terminated by ${proc.signalCode}`)
    if (!existsSync(junit)) {
      // Bun emits no JUnit for a successfully discovered but empty test suite.
      if (proc.exitCode === 0 && /^Ran 0 tests across \d+ files?\./m.test(log)) return finish(2, "no test cases ran")
      return finish(3, "test runner produced no fresh junit report")
    }
    // Bun omits import-time errors from JUnit even though they appear in its
    // terminal summary. Check both channels, including a mix of assertion and runner errors.
    if (/^\s*[1-9]\d* errors?\s*$/m.test(log) || /^# Unhandled error between tests\s*$/m.test(log))
      return finish(3, "test runner reported an unhandled error outside test assertions")
    const failed = cases.some((c) => c.outcome === "failed")
    if ((proc.exitCode !== 0 && !(proc.exitCode === 1 && failed)) || (proc.exitCode === 0 && failed))
      return finish(3, `test runner exit ${proc.exitCode} disagrees with junit outcomes`)
    if (failed) return finish(1)
    if (cases.length === 0) return finish(2, "no test cases ran")
    if (cases.some((c) => c.outcome === "notRun")) return finish(2, "required test cases were skipped")
    return finish(0)
  } catch (error) {
    return finish(3, `executor error: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const { command, flags } = args()
if (command === "verify") process.exit(await verify(flags.suite ?? "", flags))
if (command === "milestone check") {
  const { milestoneCheck } = await import("./m0/milestone-check")
  process.exit(await milestoneCheck(flags, { root, environment: environment() }))
}
console.error("usage: bench verify --suite <suite> [--dataset <id>] [--out <dir>] | bench milestone check --milestone M0 --manifest <file> [--attestation <file> --goal <file> --cost-policy <file> --run-id <id> --trusted-public-key <pem> --verifier-id <id> --verifier-deployment <export-manifest> --artifact-root <dir> --out <new-separate-dir>]")
process.exit(2)
