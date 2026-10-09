/** Prepare an inspectable local installation payload. No accounts, secrets,
 * administrator operations, model requests or device operations are performed. */
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
import { checkFrozen, digestOf, parse } from "../../packages/contracts/src"

const preview = "/private/tmp/loopit-opencode-preview.hnHSTM"
const args = process.argv.slice(2)
if (args.length % 2) throw new Error("Expected --out <new absolute directory> [--id <id>]")
const flags = new Map<string, string>()
for (let i = 0; i < args.length; i += 2) {
  if (!["--out", "--id"].includes(args[i]) || flags.has(args[i])) throw new Error("Unknown or duplicate flag")
  flags.set(args[i], args[i + 1])
}
const requested = flags.get("--out")
if (!requested || !requested.startsWith("/") || existsSync(requested)) throw new Error("--out must be a new absolute directory")
const id = flags.get("--id") ?? `m0-code-${randomUUID()}`
if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error("Invalid installation id")
const repository = resolve(import.meta.dir, "../..")
const controllerSource = join(repository, "script/m0/control-loop.ts")
if (!existsSync(controllerSource)) throw new Error("Controller source is not ready")
mkdirSync(requested, { mode: 0o700 })
const stage = realpathSync(requested), finalRoot = `/private/var/loopit/m0-runs/${id}`
const control = `${finalRoot}/control`, signer = "/private/var/loopit/signer/m0-verifier"
for (const directory of ["bin", "public", "workspace"]) mkdirSync(join(stage, directory), { mode: 0o700 })
const sha = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const writeJSON = (relative: string, value: unknown) => writeFileSync(join(stage, relative), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
function noSymlinks(path: string) {
  const absolute = resolve(path)
  let at = "/"
  for (const part of absolute.split("/").filter(Boolean)) {
    at = join(at, part)
    if (lstatSync(at).isSymbolicLink()) throw new Error(`Symbolic source path refused: ${at}`)
  }
  if (!lstatSync(path).isFile()) throw new Error("Expected a regular source file")
}
function copy(source: string, relative: string) {
  noSymlinks(source)
  copyFileSync(source, join(stage, relative), constants.COPYFILE_EXCL)
}
const bunSource = realpathSync(process.execPath) // explicitly canonicalize the installed Bun binary
copy(bunSource, "bin/bun")
copy(`${preview}/bin/opencode`, "bin/opencode")
copy(`${preview}/cache/opencode/models.json`, "public/catalog.json")
copy(join(repository, "script/macos/worker-exec.py"), "bin/worker-exec.py")
copy(join(repository, "script/macos/worker-supervisor.py"), "bin/worker-supervisor.py")
copy(join(repository, "packages/verifier/src/runner.mjs"), "public/runner.mjs")
copy(join(repository, "packages/verifier/fixtures/cases.json"), "public/tests.json")
copy(join(repository, "docs/m0/model-experiment-cost.json"), "public/cost-policy.json")
const source = 'export function sumEvenThrough(n: number): number {\n  if (!Number.isInteger(n) || n < 0 || n > 10000) throw new RangeError("n must be an integer from 0 through 10000");\n  let total = 0;\n  for (let value = 0; value < n; value += 2) total += value;\n  return total;\n}\n'
writeFileSync(join(stage, "public/source.ts"), source, { mode: 0o600 })
writeFileSync(join(stage, "workspace/sumEvenThrough.ts"), source, { mode: 0o600 })
function git(argv: string[]) {
  const result = spawnSync("/usr/bin/git", ["-C", join(stage, "workspace"), "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...argv], {
    timeout: 10000, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: stage, XDG_CONFIG_HOME: stage,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Loopit M0 Fixture", GIT_AUTHOR_EMAIL: "m0-fixture@localhost",
      GIT_COMMITTER_NAME: "Loopit M0 Fixture", GIT_COMMITTER_EMAIL: "m0-fixture@localhost" } })
  if (result.error || result.signal || result.status !== 0) throw new Error(`Fixture Git command failed: ${argv[0]}`)
  return result.stdout.trim()
}
git(["init", "--template=", "-q"]); git(["add", "sumEvenThrough.ts"])
git(["-c", "commit.gpgsign=false", "commit", "-qm", "M0 sumEvenThrough baseline"])
const revision = git(["rev-parse", "HEAD"])
if (!/^[0-9a-f]{40}$/.test(revision) || git(["status", "--porcelain"])) throw new Error("Fixture baseline not clean")

const pinned = (relative: string) => ({ path: `${finalRoot}/${relative}`, digest: sha(readFileSync(join(stage, relative))) })
const ref = (relative: string) => `${pathToFileURL(pinned(relative).path)}#${pinned(relative).digest}`
writeJSON("public/retention.json", { schemaVersion: "m0-local-retention/1", storage: "protected-local",
  automaticExternalUpload: false, credentialContentInReports: false, cleanup: "explicit controller/operator cleanup" })
const policyBody = { schemaVersion: "policy/1", policyId: "m0-pure-code", version: 1,
  permissions: { writablePaths: [`${finalRoot}/workspace`, `${finalRoot}/runtime`], network: "allowlist", networkAllowlist: ["127.0.0.1:7897"], maxSideEffect: "idempotent_write" },
  tools: [{ toolId: "opencode", version: "1.18.35" }, { toolId: "fixture-verifier", version: "1" }],
  data: { allowedSensitivity: ["public", "internal"], retentionPolicyRef: ref("public/retention.json") },
  deployment: { environments: [], channels: [], autoMerge: false },
  resources: { devices: [], workers: [], secrets: [pathToFileURL(`${control}/auth.json`).href] },
  failure: { maxTransientAttempts: 1, maxRepairCycles: 3 } }
const policy = { ...policyBody, digest: digestOf(policyBody) }
if (!parse("policy", policy).ok) throw new Error("Prepared policy is not a contract")
writeJSON("public/policy.json", policy)
const goal = { schemaVersion: "goal/1", projectId: "loopit-workbench-m0", taskId: id, goalRevision: 1,
  objective: "修复独立 M0 fixture 的 sumEvenThrough：累加从 0 到 n（含 n）的偶数；n 必须为 0 到 10000 的整数，否则抛出 RangeError。只修改 sumEvenThrough.ts。由独立 signer 验证并交付代码与证据；本任务不代表 M0 里程碑或 M1 诊断页通过。",
  scope: { repositoryRef: pathToFileURL(`${finalRoot}/workspace`).href, baseRevision: revision, allowedPaths: ["sumEvenThrough.ts"],
    inputRefs: [ref("public/source.ts"), ref("public/tests.json")], excluded: ["Loopit 业务源码", "设备操作", "账号登录", "线上发布", "修改标准或签名材料"] },
  acceptance: [{ id: "M0-CODE-01", expected: "sumEvenThrough 通过固定的 8 组结果与 4 组 RangeError 用例；独立 signer 以相同候选、目标、run 和验收摘要签发证据。", verification: "executable", evidenceKinds: ["fixture-verification-evidence"], requiredAtStage: "verification" }],
  targetMatrix: [], delivery: { artifactKinds: ["candidate", "fixture-verification-evidence"] },
  policyRef: ref("public/policy.json"), budgets: { wallMinutes: 60, maxRepairCycles: 3, maxParallelWriters: 1 },
  costBudgetRef: ref("public/cost-policy.json"), resources: { fixtureRefs: [ref("public/tests.json")], secretRefs: [pathToFileURL(`${control}/auth.json`).href] } }
const checked = parse("goal", goal)
if (!checked.ok || checkFrozen(checked.value).length) throw new Error("Prepared code-experiment goal is not frozen")
writeJSON("public/goal.json", goal)

for (const [source, destination] of [[controllerSource, "bin/controller.mjs"], [join(repository, "script/m0/verify-candidate.ts"), "bin/verifier.mjs"],
  [join(repository, "script/m0/supervisor-probe.ts"), "bin/supervisor-probe.mjs"]]) {
  const result = await Bun.build({ entrypoints: [source], target: "bun", format: "esm", packages: "bundle", splitting: false, sourcemap: "none" })
  if (!result.success || result.outputs.length !== 1) throw new Error(`Bundle failed: ${destination}: ${result.logs.map(String).join("\n")}`)
  await Bun.write(join(stage, destination), result.outputs[0])
}
const specTemplate = { schemaVersion: "m0-control-loop/1", jobId: id, runId: `run-${randomUUID()}`,
  goal: pinned("public/goal.json"), source: pinned("public/source.ts"), tests: pinned("public/tests.json"),
  executable: { ...pinned("bin/opencode"), version: "1.18.35" }, bun: pinned("bin/bun"), catalog: pinned("public/catalog.json"), wrapper: pinned("bin/worker-exec.py"),
  workspace: `${finalRoot}/workspace`, runtimeDirectory: `${finalRoot}/runtime`, controlDirectory: control, authPath: `${control}/auth.json`,
  verifierCli: pinned("bin/verifier.mjs"), verifierConfigPath: `${signer}/config.json`, verifierPublicKeyPath: `${control}/verifier-public.pem` }
const files: Array<{ path: string; size: number; digest: string; owner: "root" | "worker"; mode: number }> = []
function inventory(directory: string, prefix = "") {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name), relative = prefix ? `${prefix}/${name}` : name
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error("Staged symlink refused")
    if (stat.isDirectory()) inventory(path, relative)
    else if (stat.isFile()) files.push({ path: relative, size: stat.size, digest: sha(readFileSync(path)), owner: relative.startsWith("workspace/") ? "worker" : "root",
      mode: relative.startsWith("workspace/") ? 0o600 : ["bin/bun", "bin/opencode", "bin/worker-exec.py", "bin/worker-supervisor.py"].includes(relative) ? 0o555 : 0o444 })
    else throw new Error("Unsupported staged file")
  }
}
inventory(stage)
const manifest = { schemaVersion: "m0-control-install/1", id, finalRoot, createdAt: new Date().toISOString(),
  baselineCommit: revision, source: pinned("public/source.ts"), files, specTemplate,
  authSource: `${preview}/data/opencode/auth.json`, authHandling: "installation-only access/expiresAt/accountId; never refresh or write source",
  toolchain: { bunVersion: Bun.version, bunSource, opencodeVersion: "1.18.35" },
  sourceDigests: { controller: sha(readFileSync(controllerSource)), verifierEntry: sha(readFileSync(join(repository, "script/m0/verify-candidate.ts"))) },
  scope: "Staging only. Installation and model execution have not occurred." }
writeJSON("manifest.json", manifest)
console.log(JSON.stringify({ status: "prepared", stage, manifest: join(stage, "manifest.json"), manifestDigest: sha(readFileSync(join(stage, "manifest.json"))),
  fileCount: files.length, finalRoot, baselineCommit: revision, containsCredentials: false, administratorActions: 0, modelCalls: 0 }))
