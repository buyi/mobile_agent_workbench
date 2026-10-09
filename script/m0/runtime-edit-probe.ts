// One bounded OpenCode experiment, not a durable Worker/Supervisor or signed Gate.
// Default prepares fixtures and independent baseline checks; --run opts into ONE
// CLI runtime run, which can contain multiple native model turns (steps <= 3).
// It uses a valid access token only; no OAuth refresh token is copied.
import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { seatbelt } from "../../packages/sandbox/src/seatbelt"
import { runProcess } from "../../packages/sandbox/src/process"

const flags = process.argv.slice(2)
const option = (name: string) => {
  const index = flags.indexOf(name)
  return index < 0 ? undefined : flags[index + 1]
}
const runModel = flags.includes("--run")
const binaryRef = option("--binary")
const authRef = option("--auth-ref")
const catalogRef = option("--catalog-ref")
const model = "openai/gpt-6.1-sol"
const nonce = randomUUID()
const startedAt = new Date().toISOString()
const root = realpathSync(mkdtempSync("/private/tmp/loopit-m0-edit-"))
const workspace = join(root, "workspace")
const verifier = join(root, "verifier")
const runtime = join(root, "runtime")
const reports = join(root, "reports")
const bin = join(root, "bin")
for (const dir of [workspace, verifier, runtime, reports, bin, join(runtime, "tmp"), join(runtime, "home"), join(runtime, "config"), join(runtime, "data"), join(runtime, "cache"), join(runtime, "state")])
  mkdirSync(dir, { recursive: true, mode: 0o700 })
const hash = (text: string | Buffer) => `sha256:${createHash("sha256").update(text).digest("hex")}`
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
const source = join(workspace, "sumEvenThrough.ts")
const broken = `export function sumEvenThrough(n: number): number {\n  if (!Number.isInteger(n) || n < 0 || n > 10000) throw new RangeError("n must be an integer from 0 through 10000");\n  let total = 0;\n  for (let value = 0; value < n; value += 2) total += value;\n  return total;\n}\n`
const corrected = broken.replace("value < n", "value <= n")
const pairs = [[0, 0], [1, 0], [2, 2], [3, 2], [4, 6], [10, 30], [11, 30], [10000, 25005000]]
const testBody = `import { expect, test } from "bun:test";\nimport { sumEvenThrough } from ${JSON.stringify(source)};\n${pairs.map(([n, total]) => `test("sum(${n})=${total}", () => expect(sumEvenThrough(${n})).toBe(${total}));`).join("\n")}\n${["-1", "1.5", "NaN", "10001"].map((n) => `test("reject ${n}", () => expect(() => sumEvenThrough(${n})).toThrow(RangeError));`).join("\n")}\n`
const testFile = join(verifier, "sum.test.ts")
writeFileSync(source, broken)
writeFileSync(testFile, testBody, { mode: 0o400 })
const testDigest = hash(readFileSync(testFile))
const copiedBun = join(bin, "bun")
copyFileSync(realpathSync(process.execPath), copiedBun)
chmodSync(copiedBun, 0o500)
const safeEnv = { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: "en_US.UTF-8", NO_COLOR: "1" }
const denyRead = [realpathSync(homedir()), ...(authRef ? [realpathSync(resolve(dirname(authRef), "../.."))] : [])]
const result: Record<string, unknown> = {
  nonce, startedAt, scriptDigest: hash(readFileSync(import.meta.path)), model, mode: runModel ? "single-runtime-run" : "prepare-only", root,
  limits: { modelTimeoutMs: 60000, agentSteps: 3, automaticRepairAttempts: 0 },
  dollars: { status: "unknown", source: "OAuth subscription; no dollar cap claim" },
  baselineSourceDigest: hash(broken), testDigest, candidateDigest: null,
  acknowledgement: { status: "not_observed", note: "CLI does not expose a separate durable prompt admission receipt" },
  process: { status: "not_started" }, independentCheck: { status: "not_run" }, signedGate: false,
  limitations: [
    "This probe is not a durable Supervisor; process-group timeout is not proof that arbitrary detached descendants have stopped.",
    "OpenCode apply_patch authorizes the original path, not its move destination; extra workspace changes are rejected after execution.",
    "Proxy mode allows only the existing localhost proxy port; destination-domain allowlisting is not implemented.",
    "Dedicated Worker account and cross-account isolation remain unverified.",
    "Read-only verifier plus sandboxed execution is a local experiment, not an independently signed delivery Gate.",
  ],
}
function save() {
  writeJson(join(reports, "result.json"), result)
  const files = readdirSync(reports).filter((name) => name !== "artifact-manifest.json")
  writeJson(join(reports, "artifact-manifest.json"), files.map((path) => ({ path, digest: hash(readFileSync(join(reports, path))) })))
}

async function verify(label: string) {
  const scratch = join(root, `verify-${label}`)
  mkdirSync(scratch, { mode: 0o700 })
  const junit = join(scratch, "junit.xml")
  const command = seatbelt().command([copiedBun, "test", testFile, "--reporter=junit", `--reporter-outfile=${junit}`], {
    workdir: scratch, writable: [], denyRead: [...denyRead, runtime], network: { mode: "none" },
    env: { ...safeEnv, TMPDIR: scratch, XDG_CONFIG_HOME: scratch, XDG_DATA_HOME: scratch, XDG_CACHE_HOME: scratch, XDG_STATE_HOME: scratch },
  })
  const output = await runProcess(command.argv, { cwd: scratch, env: command.env, timeoutMs: 10000 })
  const xml = existsSync(junit) ? readFileSync(junit, "utf8") : ""
  const header = /<testsuites\b([^>]*)>/.exec(xml)?.[1] ?? ""
  const count = (key: string) => Number(new RegExp(`\\b${key}="(\\d+)"`).exec(header)?.[1] ?? NaN)
  const complete = xml.trimEnd().endsWith("</testsuites>") && count("tests") === 12 && !/<error\b/.test(xml)
  const testUnchanged = hash(readFileSync(testFile)) === testDigest
  writeFileSync(join(reports, `${label}.log`), `${output.stdout}\n${output.stderr}`, { mode: 0o600 })
  if (xml) writeFileSync(join(reports, `${label}.junit.xml`), xml, { mode: 0o600 })
  return {
    exitCode: output.code, signal: output.signal, timedOut: output.timedOut, runnerError: output.error,
    tests: Number.isFinite(count("tests")) ? count("tests") : 0,
    failed: Number.isFinite(count("failures")) ? count("failures") : null,
    skipped: Number.isFinite(count("skipped")) ? count("skipped") : null,
    testUnchanged, profileDigest: command.profileDigest,
    passed: output.code === 0 && !output.timedOut && !output.signal && !output.error && complete && count("failures") === 0 && count("skipped") === 0 && testUnchanged,
    complete,
  }
}

async function main() {
  if (process.platform !== "darwin") throw new Error("This probe requires macOS Seatbelt; there is no unsandboxed fallback")
  // With a real Git working tree, native tool permission patterns are relative to
  // this workspace. Without one, OpenCode's global worktree can be '/'.
  for (const args of [["init", "-q", workspace]]) {
    const git = await runProcess(["/usr/bin/git", ...args], { env: safeEnv })
    if (git.code !== 0) throw new Error("Cannot initialize isolated fixture working tree")
  }
  const negative = await verify("known-broken")
  writeFileSync(source, corrected)
  const positive = await verify("known-good")
  writeFileSync(source, broken)
  result.baselines = { negative, positive }
  if (!negative.complete || negative.exitCode !== 1 || !negative.failed || !negative.testUnchanged || !positive.passed)
    throw new Error("Independent verifier baseline failed; do not start a model request")
  if (!runModel) { result.status = "prepared"; save(); return }
  if (!binaryRef || !authRef || !catalogRef) throw new Error("--run requires --binary, --auth-ref and --catalog-ref")
  const authBytes = readFileSync(authRef)
  const authDigest = hash(authBytes)
  let auth: { type?: string; access?: string; expires?: number; accountId?: string }
  try { auth = JSON.parse(authBytes.toString()).openai } catch { throw new Error("Auth reference contains invalid JSON; its contents are not logged") }
  if (auth?.type !== "oauth" || typeof auth.access !== "string" || !auth.access || typeof auth.expires !== "number" || !Number.isFinite(auth.expires) || auth.expires < Date.now() + 120000)
    throw new Error("Current access token is absent or lacks the two-minute validity margin; refresh is not attempted")
  // No original refresh token is copied to child env, config, logs, or disk.
  const accessOnly = { type: "oauth", access: auth.access, expires: auth.expires, refresh: "", ...(typeof auth.accountId === "string" ? { accountId: auth.accountId } : {}) }
  const redact = (text: string) => text.replaceAll(accessOnly.access, "[REDACTED_ACCESS]")
  const proxy = new URL(process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "")
  if (proxy.protocol !== "http:" || proxy.hostname !== "127.0.0.1" || proxy.port !== "7897" || proxy.username || proxy.password)
    throw new Error("Expected existing localhost:7897 HTTP proxy; no network policy fallback")
  const executable = join(bin, "opencode")
  copyFileSync(realpathSync(binaryRef), executable)
  chmodSync(executable, 0o500)
  const catalog = join(runtime, "catalog.json")
  copyFileSync(catalogRef, catalog)
  const permissions = { "*": "deny", read: { "*": "deny", "sumEvenThrough.ts": "allow" }, edit: { "*": "deny", "sumEvenThrough.ts": "allow" }, external_directory: "deny" }
  const config = {
    model, small_model: model, share: "disabled", autoupdate: false, formatter: false, lsp: false, mcp: {}, plugin: [], instructions: [],
    permission: permissions, agent: { probe: { mode: "primary", model, steps: 3, permission: permissions } },
    compaction: { auto: false, prune: false },
  }
  writeJson(join(reports, "config.json"), config)
  const env: Record<string, string> = {
    ...safeEnv, TMPDIR: join(runtime, "tmp"), OPENCODE_TEST_HOME: join(runtime, "home"),
    XDG_CONFIG_HOME: join(runtime, "config"), XDG_DATA_HOME: join(runtime, "data"), XDG_CACHE_HOME: join(runtime, "cache"), XDG_STATE_HOME: join(runtime, "state"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: accessOnly }),
    OPENCODE_MODELS_PATH: catalog, OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_PURE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
    OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "2048", HTTP_PROXY: proxy.href, HTTPS_PROXY: proxy.href, ALL_PROXY: proxy.href,
  }
  const prompt = `M0 bounded editing experiment ${nonce}. Fix only sumEvenThrough.ts. It must sum every even integer from 0 THROUGH n inclusive. n must be an integer between 0 and 10000; other inputs throw RangeError. Use the read and apply_patch tools. Do not move, rename, delete, or create other files. Do not run commands or tests. The independent fixed tests are outside your writable workspace, and the harness will run them after you exit. Expected cases: ${JSON.stringify(pairs)}. Invalid inputs: -1, 1.5, NaN, 10001. Make the smallest fix, then briefly report the change. Do not claim the independent tests passed.`
  writeFileSync(join(reports, "prompt.txt"), prompt, { mode: 0o600 })
  const command = seatbelt().command([executable, "--pure", "run", "--format", "json", "--model", model, "--agent", "probe", "--variant", "low", "--title", `M0 probe ${nonce}`, prompt], {
    workdir: workspace, writable: [runtime], denyRead, network: { mode: "proxy", port: 7897 }, env,
  })
  const preflightCommand = seatbelt().command([executable, "--pure", "debug", "config"], {
    workdir: workspace, writable: [runtime], denyRead, network: { mode: "proxy", port: 7897 }, env,
  })
  const preflight = await runProcess(preflightCommand.argv, { cwd: workspace, env: preflightCommand.env, timeoutMs: 20000 })
  if (preflight.code !== 0 || preflight.timedOut || preflight.error || preflight.stdout.length >= 65536)
    throw new Error("Native resolved-config preflight failed under Seatbelt; no model call was made")
  const resolved = JSON.parse(preflight.stdout)
  if (JSON.stringify(resolved.permission) !== JSON.stringify(permissions) || resolved.agent?.probe?.steps !== 3 ||
      resolved.formatter !== false || resolved.lsp !== false || Object.keys(resolved.mcp ?? {}).length || resolved.plugin?.length)
    throw new Error("Native resolved configuration does not match restricted probe policy")
  result.configPreflight = { passed: true, permissionMatches: true, agentSteps: 3, lsp: false, formatter: false, mcpCount: 0, externalPluginCount: 0 }
  result.auth = { mode: "native-access-only-env", refreshTokenSupplied: false, originalStoreWritten: false }
  result.sandbox = { model: { mode: "proxy", port: 7897, profileDigest: command.profileDigest }, verifier: { mode: "none" } }
  result.binaryDigest = hash(readFileSync(executable))
  result.catalogDigest = hash(readFileSync(catalog))
  result.promptSentAt = new Date().toISOString()
  result.process = { status: "starting" }
  save()
  const output = await runProcess(command.argv, { cwd: workspace, env: command.env, timeoutMs: 60000 })
  // runProcess joins chunks in memory. If its bounded capture could be truncated,
  // omit the entire stream rather than persist a partial credential fragment.
  const truncated = output.stdout.length >= 65536 || output.stderr.length >= 65536
  const stdout = truncated ? "" : redact(output.stdout)
  const stderr = truncated ? "[output omitted: capture limit reached]" : redact(output.stderr)
  writeFileSync(join(reports, "runtime.jsonl"), stdout, { mode: 0o600 })
  writeFileSync(join(reports, "runtime.stderr.log"), stderr, { mode: 0o600 })
  const events = stdout.split("\n").flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
  const steps = events.filter((event) => event.type === "step_finish")
  result.executionObserved = { sessionIds: [...new Set(events.map((event) => event.sessionID).filter(Boolean))], firstEventAt: events[0]?.timestamp ?? null }
  result.tokens = steps.map((event) => ({ messageID: event.part?.messageID, tokens: event.part?.tokens ?? null, reportedCost: event.part?.cost ?? null }))
  result.process = { status: "exited", exitCode: output.code, signal: output.signal, timedOut: output.timedOut, captureTruncated: truncated, error: output.error ? redact(output.error) : undefined }
  result.toolCalls = events.filter((event) => event.type === "tool_use").map((event) => ({ tool: event.part?.tool, status: event.part?.state?.status }))
  const database = new Database(join(runtime, "data/opencode/opencode.db"), { readonly: true })
  const messages = database.query("select id, data from message").all() as { id: string; data: string }[]
  database.close()
  const decoded = messages.map((row) => ({ id: row.id, ...JSON.parse(row.data) }))
  const actualModels = [...new Set(decoded.filter((message) => message.role === "assistant").map((message) => `${message.providerID}/${message.modelID}`))]
  result.actualModels = actualModels
  result.durablePromptRecord = {
    observedAfterExit: true,
    messageIDs: decoded.filter((message) => message.role === "user").map((message) => message.id),
    note: "Retrospective local DB evidence; not an ACK observed before execution",
  }
  result.finishedAt = new Date().toISOString()
  result.originalAuthUnchanged = hash(readFileSync(authRef)) === authDigest
  const names = readdirSync(workspace).filter((name) => name !== ".git")
  const boundaryIntact = names.length === 1 && names[0] === "sumEvenThrough.ts" && lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink() && hash(readFileSync(testFile)) === testDigest
  result.boundaryIntact = boundaryIntact
  if (!boundaryIntact) throw new Error("Candidate changed the allowed workspace shape or protected test; independent execution refused")
  const candidate = readFileSync(source, "utf8")
  result.candidateDigest = hash(candidate)
  writeFileSync(join(reports, "candidate.ts"), redact(candidate), { mode: 0o600 })
  const check = await verify("candidate")
  result.independentCheck = check
  result.status = output.code === 0 && !output.timedOut && !output.signal && !output.error && !truncated && !events.some((event) => event.type === "error") && actualModels.length === 1 && actualModels[0] === model && check.passed && candidate !== broken
    ? "probe-passed" : "probe-not-passed"
  save()
}

try {
  await main()
} catch (error) {
  // Do not stringify opaque child/provider objects; errors here are local controls.
  result.status = "blocked"
  result.reason = error instanceof Error ? error.message : "Probe failed"
  save()
}
console.log(JSON.stringify({ status: result.status, report: join(reports, "result.json"), modelRequestAttempted: !!result.promptSentAt }))
process.exitCode = result.status === "probe-passed" || result.status === "prepared" ? 0 : 2
