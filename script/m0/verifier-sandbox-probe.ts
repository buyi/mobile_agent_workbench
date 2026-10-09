/** Reproduce the operator-UID Seatbelt experiment; no real keys, model, device or
 * dedicated Signer identity is used. Run on macOS with ordinary user privileges:
 * bun script/m0/verifier-sandbox-probe.ts [--out /absolute/new-directory]
 * This is an actual OS probe, deliberately outside the ordinary test suite. */
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createServer, connect, type Server, type Socket } from "node:net"
import { isAbsolute, join, resolve } from "node:path"
import { captureProcess, executeCase, fixtureSandbox, type ChildResult } from "../../packages/verifier/src/sandbox"

const hash = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 })
const completed = (result: ChildResult) => result.code === 0 && !result.signal && !result.error && !result.timedOut && !result.overflow
const source = 'function sumEvenThrough(n) { if (!Number.isInteger(n) || n < 0 || n > 10000) throw new RangeError("bad"); let s = 0; for (let i = 0; i <= n; i += 2) s += i; return s; }\n'
const negativeSource = `import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
const request = JSON.parse(await Bun.stdin.text());
const reads = request.paths.map(path => {
  try { readFileSync(path); return { denied: false }; }
  catch (error) { return { denied: ["EPERM", "EACCES"].includes(error.code), code: error.code }; }
});
const fork = spawnSync(process.execPath, ["-e", 'console.log("SHOULD_NOT_RUN")'], { timeout: 1000, encoding: "utf8" });
const network = await new Promise(resolve => {
  const socket = connect(request.port, "127.0.0.1");
  let settled = false;
  const finish = value => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); };
  const timer = setTimeout(() => finish({ denied: false, timedOut: true }), 1000);
  socket.once("connect", () => finish({ denied: false }));
  socket.once("error", error => finish({ denied: ["EPERM", "EACCES", "ECONNREFUSED"].includes(error.code), code: error.code }));
});
console.log(JSON.stringify({ schemaVersion: "verifier-sandbox-observation/1", nonce: request.nonce, reads,
  fork: { denied: fork.error?.code === "EPERM", code: fork.error?.code, status: fork.status, signal: fork.signal }, network }));
`

async function listen(server: Server) {
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("loopback_listener_timeout")), 1000)
    server.once("error", (error) => { clearTimeout(timer); reject(error) })
    server.listen(0, "127.0.0.1", () => { clearTimeout(timer); accept() })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("loopback_listener_unavailable")
  return address.port
}
function reachable(port: number, expected: string): Promise<{ reachable: boolean; code?: string }> {
  return new Promise((accept) => {
    const socket = connect(port, "127.0.0.1")
    let bytes = "", settled = false
    const finish = (result: { reachable: boolean; code?: string }) => {
      if (settled) return
      settled = true; clearTimeout(timer); socket.destroy(); accept(result)
    }
    const timer = setTimeout(() => finish({ reachable: false, code: "baseline_timeout" }), 1000)
    socket.on("data", (data: Buffer) => { bytes += data.toString("utf8"); if (bytes.length > 256) finish({ reachable: false, code: "baseline_overflow" }) })
    socket.once("end", () => finish({ reachable: bytes === expected }))
    socket.once("error", (error: NodeJS.ErrnoException) => finish({ reachable: false, code: error.code }))
    socket.once("close", () => { if (!settled) finish({ reachable: false, code: "baseline_closed" }) })
  })
}

async function probe(root: string) {
  const startedAt = new Date().toISOString(), runtime = realpathSync(process.execPath)
  const files = {
    script: realpathSync(import.meta.path), sandbox: realpathSync(resolve(import.meta.dir, "../../packages/verifier/src/sandbox.ts")),
    runner: realpathSync(resolve(import.meta.dir, "../../packages/verifier/src/runner.mjs")),
    cases: realpathSync(resolve(import.meta.dir, "../../packages/verifier/fixtures/cases.json")),
  }
  const scratch = join(root, "scratch"); mkdirSync(scratch, { mode: 0o700 })
  const runner = join(root, "runner.mjs"), compiled = join(root, "candidate.js"), negativeRunner = join(root, "negative.mjs")
  writeFileSync(runner, readFileSync(files.runner), { flag: "wx", mode: 0o600 })
  writeFileSync(compiled, source, { flag: "wx", mode: 0o600 })
  writeFileSync(negativeRunner, negativeSource, { flag: "wx", mode: 0o600 })
  const canaries = ["key-canary", "tests-canary"].map((name) => {
    const path = join(root, name), bytes = `NONSECRET ${name} Seatbelt boundary canary\n`
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }); return { path, digest: hash(bytes) }
  })
  const canariesReadable = () => canaries.every((item) => { try { return hash(readFileSync(item.path)) === item.digest } catch { return false } })
  const base = { runtime, runner, compiled, scratch, request: {}, timeoutMs: 3000 }
  const positiveProfile = fixtureSandbox(base), negativeProfile = fixtureSandbox({ ...base, runner: negativeRunner })
  const report: Record<string, any> = {
    schemaVersion: "verifier-sandbox-probe/1", status: "blocked", startedAt,
    scope: "Actual macOS Seatbelt under the invoking operator UID, using nonsecret canaries; not dedicated UID 421 deployment, independent verifier identity, public-network reachability or M0 milestone acceptance",
    identity: { uid: process.getuid?.(), effectiveUid: process.geteuid?.(), gid: process.getgid?.(), dedicatedSignerVerified: false },
    code: Object.fromEntries(Object.entries(files).map(([name, path]) => [name, { path, digest: hash(readFileSync(path)) }])),
    runtime: { path: runtime, digest: hash(readFileSync(runtime)), version: Bun.version },
    candidate: { path: compiled, digest: hash(source) }, negativeRunner: { path: negativeRunner, digest: hash(negativeSource) },
    profiles: { positive: positiveProfile, negative: negativeProfile }, canaries,
    positive: { status: "notRun", results: [] }, negative: { status: "notRun" },
    credentialFilesRead: false, modelCalls: 0, deviceOperations: 0, milestonePassed: false,
  }
  const sockets = new Set<Socket>()
  let server: Server | undefined
  try {
    const fixture = JSON.parse(readFileSync(files.cases, "utf8"))
    const expectedInputs = [0, 1, 2, 3, 4, 10, 11, 10000, -1, 1.5, "NaN", 10001], values = [0, 0, 2, 2, 6, 30, 30, 25005000]
    if (fixture.schemaVersion !== "sum-even-cases/1" || fixture.cases?.length !== 12 || fixture.cases.some((item: any, index: number) =>
      item.input !== expectedInputs[index] || JSON.stringify(item.expected) !== JSON.stringify(index < 8 ? { kind: "returned", value: values[index] } : { kind: "threw", name: "RangeError" })))
      throw new Error("fixed_12_case_fixture_changed")
    const results: Array<{ caseIndex: number; id: string; request: unknown; expected: unknown; passed: boolean; result: ChildResult }> = []
    report.positive = { status: "running", results }
    for (const [caseIndex, item] of fixture.cases.entries()) {
      const request = { nonce: randomUUID(), caseIndex, input: item.input, compiledDigest: hash(source) }
      const result = await executeCase({ ...base, request })
      let observation: any
      try { observation = JSON.parse(result.stdout) } catch { /* Rejected by binding checks below. */ }
      const passed = completed(result) && observation?.schemaVersion === "fixture-observation/1" && observation.nonce === request.nonce &&
        observation.caseIndex === caseIndex && observation.compiledDigest === request.compiledDigest && JSON.stringify(observation.observation) === JSON.stringify(item.expected)
      results.push({ caseIndex, id: item.id, request, expected: item.expected, passed, result })
    }
    report.positive = { status: results.every((item) => item.passed) ? "passed" : "failed", results }
    const canariesReadableBefore = canariesReadable()
    const marker = `fork-baseline-${randomUUID()}`
    const forkBaseline = await captureProcess(runtime, ["-e", `console.log(${JSON.stringify(marker)})`], scratch, {}, 1000)
    const forkRunnableBefore = completed(forkBaseline) && forkBaseline.stdout.trim() === marker
    let connections = 0
    const handshake = `loopit-probe-${randomUUID()}`
    server = createServer((socket) => {
      connections++; sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {}); socket.end(handshake)
    })
    const port = await listen(server), before = await reachable(port, handshake)
    const countBefore = connections
    report.negative = { status: "notRun", endpoint: `127.0.0.1:${port}`, baseline: { before, forkRunnableBefore, canariesReadableBefore, forkResult: forkBaseline } }
    if (!before.reachable || !canariesReadableBefore || !forkRunnableBefore) throw new Error("negative_probe_baseline_unavailable")
    const nonce = randomUUID()
    const result = await captureProcess("/usr/bin/sandbox-exec", ["-p", negativeProfile.text,
      ...Object.entries(negativeProfile.params).flatMap(([key, value]) => ["-D", `${key}=${value}`]), runtime, negativeRunner],
    scratch, { nonce, paths: canaries.map((item) => item.path), port }, 3000)
    const after = await reachable(port, handshake)
    await Bun.sleep(20) // drain listener callbacks after both the child and baseline sockets closed
    const childConnections = connections - countBefore - (after.reachable ? 1 : 0)
    const canariesReadableAfter = canariesReadable()
    let observations: any
    try { observations = JSON.parse(result.stdout) } catch { /* Failed probe, never a denied-operation pass. */ }
    const bound = completed(result) && observations?.schemaVersion === "verifier-sandbox-observation/1" && observations.nonce === nonce
    const checks = {
      canaryReadDenied: bound && observations.reads?.length === 2 && observations.reads.every((item: any) => item.denied === true && ["EPERM", "EACCES"].includes(item.code)) && canariesReadableAfter,
      bunForkDenied: bound && observations.fork?.denied === true && observations.fork.code === "EPERM",
      loopbackDenied: bound && observations.network?.denied === true && ["EPERM", "EACCES", "ECONNREFUSED"].includes(observations.network.code) && after.reachable && childConnections === 0,
    }
    report.negative = { ...report.negative, status: !after.reachable || !canariesReadableAfter ? "blocked" : Object.values(checks).every(Boolean) ? "passed" : "failed",
      nonce, baseline: { ...report.negative.baseline, after, childConnections, totalConnections: connections, canariesReadableAfter }, checks, result, observations }
    report.status = report.negative.status === "blocked" ? "blocked" : report.positive.status === "passed" && report.negative.status === "passed" ? "passed" : "failed"
  } catch (error) {
    report.status = "blocked"; report.error = error instanceof Error ? error.message : "probe_unavailable"
    if (report.positive.status === "running") report.positive.status = "blocked"
  } finally {
    for (const socket of sockets) socket.destroy()
    if (server) await new Promise<void>((accept) => server!.close(() => accept()))
    report.finishedAt = new Date().toISOString()
    json(join(root, "result.json"), report)
  }
  return report
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: bun script/m0/verifier-sandbox-probe.ts [--out /absolute/new-directory]\nRuns actual macOS Seatbelt under the ordinary invoking UID, with nonsecret canaries only.")
    return
  }
  if (args.length && (args.length !== 2 || args[0] !== "--out" || !isAbsolute(args[1]))) throw new Error("expected_optional_out_new_absolute_directory")
  if (process.platform !== "darwin" || process.getuid?.() === 0 || process.geteuid?.() === 0) throw new Error("ordinary_user_macos_required")
  const output = args[1] ?? mkdtempSync("/private/tmp/loopit-verifier-sandbox-")
  if (args[1]) mkdirSync(output, { mode: 0o700 }) // refuse every existing destination
  const root = realpathSync(output), report = await probe(root)
  console.log(JSON.stringify({ status: report.status, report: join(root, "result.json"), positivesPassed: report.positive.results.filter((item: any) => item.passed).length,
    negativeStatus: report.negative.status, dedicatedSignerVerified: false, milestonePassed: false }))
  if (report.status !== "passed") process.exitCode = 2
}

if (import.meta.main) main().catch((error) => { console.error(error instanceof Error ? error.message : "probe_unavailable"); process.exitCode = 2 })
