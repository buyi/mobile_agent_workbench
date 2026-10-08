// Frozen evaluation entry (acceptance-spec.md §7, M0 §7):
//   bun script/bench.ts verify --suite <suite> [--dataset <id>] [--out <dir>]
//   bun script/bench.ts milestone check --milestone M0 --manifest <file>
// Each run writes result.json, events.jsonl, artifact-manifest.json, metrics.json and
// human-interventions.json. Exit codes: 0 passed, 1 assertion failed, 2 environment
// blocked / not runnable, 3 executor error. notRun is never reported as passed.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { datasetDigest } from "../packages/contracts/test/fixtures"

const root = join(import.meta.dir, "..")

interface Suite {
  readonly tests?: string
  readonly dataset?: { readonly id: string; readonly digest: () => string }
  readonly blocked?: string
}

const suites: Record<string, Suite> = {
  "contract-core": {
    tests: "./packages/contracts/test",
    dataset: { id: "contract-core/1", digest: datasetDigest },
  },
  "control-plane": { tests: "./packages/delivery/test" },
  "sandbox-contract":
    process.platform === "darwin"
      ? { tests: "./packages/sandbox/test" }
      : { blocked: "Seatbelt conformance requires a macOS host (run as loopit-worker, see script/macos/setup-worker.sh)" },
  "runtime-contract": { blocked: "OpenCode Runtime adapter deferred (2026-10-08): using OpenCode's default model configuration for now" },
  "device-contract": { blocked: "M0-T04 not implemented: no registered device, platform or macOS worker" },
  recovery: { blocked: "M0-T05/T07 not implemented: no channel policy or independent recovery log" },
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
  const cases = [...xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)].map((m) => {
    const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(m[1])?.[1] ?? ""
    const body = m[3] ?? ""
    const outcome = /<failure|<error/.test(body) ? "failed" : /<skipped/.test(body) ? "notRun" : "passed"
    return { name: attr("name"), classname: attr("classname"), file: attr("file"), seconds: Number(attr("time") || 0), outcome }
  })
  return cases
}

async function verify(suiteName: string, flags: Record<string, string>) {
  const suite = suites[suiteName]
  const started = new Date()
  const out = flags.out ?? join(root, ".bench", suiteName, started.toISOString().replace(/[:.]/g, "-"))
  const base = { suite: suiteName, startedAt: started.toISOString(), environment: environment() }

  if (!suite || suite.blocked) {
    const reason = suite?.blocked ?? `unknown suite ${suiteName}; known: ${Object.keys(suites).join(", ")}`
    write(out, {
      "result.json": { ...base, verdict: "blocked", reason, sampleCount: 0, passed: 0, failed: 0, blocked: 0, notRun: 1 },
      "events.jsonl": "",
      "artifact-manifest.json": [],
      "metrics.json": {},
      "human-interventions.json": [],
    })
    console.error(`blocked: ${reason}\n${out}`)
    return 2
  }
  if (flags.dataset && suite.dataset && flags.dataset !== suite.dataset.id) {
    console.error(`dataset ${flags.dataset} is not the frozen dataset ${suite.dataset.id}`)
    return 2
  }
  if (!existsSync(join(root, "node_modules/@opencode-ai/core"))) {
    console.error("environment not set up: run `bun install --frozen-lockfile` in vendor/opencode, then `bun script/setup.ts`")
    return 2
  }

  const junit = join(out, "junit.xml")
  mkdirSync(out, { recursive: true })
  const proc = Bun.spawnSync([process.execPath, "test", suite.tests!, "--reporter=junit", `--reporter-outfile=${junit}`], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const log = proc.stdout.toString() + proc.stderr.toString()
  if (!existsSync(junit)) {
    write(out, { "runner.log": log })
    console.error(`executor error: no junit report\n${out}`)
    return 3
  }
  const cases = parseJunit(readFileSync(junit, "utf8"))
  const count = (o: string) => cases.filter((c) => c.outcome === o).length
  const failed = count("failed")
  const verdict = cases.length === 0 ? "blocked" : failed > 0 ? "failed" : count("notRun") > 0 ? "blocked" : "passed"
  const finished = new Date()
  const hash = (file: string) => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`
  write(out, {
    "runner.log": log,
    "result.json": {
      ...base,
      finishedAt: finished.toISOString(),
      dataset: suite.dataset ? { id: suite.dataset.id, digest: suite.dataset.digest() } : undefined,
      verdict,
      sampleCount: cases.length,
      passed: count("passed"),
      failed,
      blocked: 0,
      notRun: count("notRun"),
      cases,
    },
    "events.jsonl": cases.map((c) => JSON.stringify({ type: "case.finished", ...c })).join("\n") + "\n",
    "metrics.json": { durationMs: finished.getTime() - started.getTime(), caseSeconds: cases.reduce((s, c) => s + c.seconds, 0) },
    // Suites run unattended; any manual step during a run must be appended here by the operator tooling.
    "human-interventions.json": [],
  })
  write(out, {
    "artifact-manifest.json": ["junit.xml", "runner.log", "result.json", "events.jsonl", "metrics.json"].map((file) => ({
      path: file,
      digest: hash(join(out, file)),
    })),
  })
  console.log(`${suiteName}: ${verdict} (${count("passed")} passed, ${failed} failed, ${count("notRun")} notRun)\n${out}`)
  return verdict === "passed" ? 0 : verdict === "failed" ? 1 : 2
}

const { command, flags } = args()
if (command === "verify") process.exit(await verify(flags.suite ?? "", flags))
if (command === "milestone check") {
  console.error("blocked: milestone checker is M0-T08; M0 cannot pass before T03–T07 and the user's M1 goal exist")
  process.exit(2)
}
console.error("usage: bench verify --suite <suite> [--dataset <id>] [--out <dir>] | bench milestone check --milestone <M> --manifest <file>")
process.exit(2)
