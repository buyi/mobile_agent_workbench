/** Nonprivileged staging only. Root reviews this manifest before provisioning. */
import { createHash, randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { checkFrozen, digestOf, parse } from "../../packages/contracts/src"
import type { ControlMatrixSpec } from "./control-matrix"
import { controlMatrixFixtureSource } from "./control-matrix-fixture"
const flags = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) {
  if (!["--out", "--id", "--protected-run", "--experiment"].includes(process.argv[i]) || !process.argv[i + 1] || flags.has(process.argv[i])) throw new Error("invalid_arguments")
  flags.set(process.argv[i], process.argv[i + 1])
}
const out = flags.get("--out")!, prior = flags.get("--protected-run")!
const experiment = flags.get("--experiment") ?? "control-matrix"
if (!["control-matrix", "owner-loss"].includes(experiment)) throw new Error("invalid_experiment")
const proofExport = "/private/var/loopit/verifier-deployment-export"
const priorInstall = JSON.parse(readFileSync(join(proofExport, "installManifest.json"), "utf8"))
if (!out?.startsWith("/") || existsSync(out) || !/^\/private\/var\/loopit\/m0-runs\/[a-zA-Z0-9-]+$/.test(prior) || prior !== priorInstall.finalRoot)
  throw new Error("new_absolute_out_and_exact_protected_prior_job_required")
const id = flags.get("--id") ?? `m0-control-matrix-${randomUUID()}`
if (!/^[a-z0-9][a-z0-9-]{0,90}$/.test(id)) throw new Error("invalid_id")
mkdirSync(out, { mode: 0o700 })
const stage = realpathSync(out), finalRoot = `/private/var/loopit/m0-runs/${id}`
for (const sub of ["bin", "public", "workspace"]) mkdirSync(join(stage, sub), { mode: 0o700 })
const sha = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const files: Array<{ path: string; digest: string; mode: number; uid: number; gid: number }> = []
const write = (path: string, bytes: Buffer | string, worker = false, executable = false) => {
  writeFileSync(join(stage, path), bytes, { flag: "wx", mode: 0o600 })
  files.push({ path, digest: sha(bytes), mode: worker ? 0o600 : executable ? 0o555 : 0o444, uid: worker ? 420 : 0, gid: worker ? 420 : 0 })
}
write("bin/bun", readFileSync(realpathSync(process.execPath)), false, true)
for (const file of ["worker-exec.py", "worker-supervisor.py"]) write(`bin/${file}`, readFileSync(resolve(import.meta.dir, "../macos", file)), false, true)
// This pinned executable implements only the CLI transport used by Runtime.
// It neither imports an SDK nor opens a socket. It is not real model evidence.
write("bin/unbilled-fixture", controlMatrixFixtureSource(`${finalRoot}/bin/bun`), false, true)
write("public/catalog.json", "{}\n")
write("workspace/fixture.txt", "No model or business source changes.\n", true)
function git(argv: string[]) {
  const result = spawnSync("/usr/bin/git", ["-C", join(stage, "workspace"), "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...argv], {
    timeout: 10000, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: stage, XDG_CONFIG_HOME: stage,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Loopit M0 Control Fixture", GIT_AUTHOR_EMAIL: "m0-control@localhost",
      GIT_COMMITTER_NAME: "Loopit M0 Control Fixture", GIT_COMMITTER_EMAIL: "m0-control@localhost" } })
  if (result.error || result.signal || result.status !== 0) throw new Error(`fixture_git_failed:${argv[0]}`)
  return result.stdout.trim()
}
git(["init", "--template=", "-q"]); git(["add", "fixture.txt"])
git(["-c", "commit.gpgsign=false", "commit", "-qm", "M0 no-model control fixture baseline"])
const baselineCommit = git(["rev-parse", "HEAD"])
if (!/^[0-9a-f]{40}$/.test(baselineCommit) || git(["status", "--porcelain"])) throw new Error("fixture_git_baseline_not_clean")
const gitDirectories: Array<{ path: string; uid: number; gid: number; mode: number }> = []
function inventoryGit(relative: string) {
  const path = join(stage, relative), st = lstatSync(path)
  if (st.isSymbolicLink()) throw new Error("fixture_git_symlink_refused")
  if (st.isDirectory()) {
    gitDirectories.push({ path: relative, uid: 420, gid: 420, mode: 0o700 })
    for (const name of readdirSync(path).sort()) inventoryGit(`${relative}/${name}`)
  } else if (st.isFile()) files.push({ path: relative, digest: sha(readFileSync(path)), uid: 420, gid: 420, mode: 0o600 })
  else throw new Error("fixture_git_special_file_refused")
}
inventoryGit("workspace/.git")
if (existsSync(join(stage, "workspace/.git/hooks"))) throw new Error("fixture_git_hooks_refused")
const pin = (relative: string) => ({ path: `${finalRoot}/${relative}`, digest: files.find((file) => file.path === relative)!.digest })
const ref = (relative: string) => `${pathToFileURL(pin(relative).path).href}#${pin(relative).digest}`
write("public/retention.json", JSON.stringify({ schemaVersion: "matrix-retention/1", storage: "root-local", containsCredentials: false }))
const policyBody = { schemaVersion: "policy/1", policyId: "m0-control-matrix", version: 1,
  permissions: { writablePaths: [`${finalRoot}/workspace`, `${finalRoot}/runtime`], network: "none", maxSideEffect: "idempotent_write" },
  tools: [{ toolId: "unbilled-fixture", version: "1" }], data: { allowedSensitivity: ["public", "internal"], retentionPolicyRef: ref("public/retention.json") },
  deployment: { environments: [], channels: [], autoMerge: false }, resources: { devices: [], workers: [], secrets: [] }, failure: { maxTransientAttempts: 1, maxRepairCycles: 3 } }
const policy = { ...policyBody, digest: digestOf(policyBody) }
if (!parse("policy", policy).ok) throw new Error("invalid_fixture_policy")
write("public/policy.json", JSON.stringify(policy))
write("public/cost-policy.json", JSON.stringify({ schemaVersion: "fixture-unbilled/1", modelCalls: 0 }))
const goal = { schemaVersion: "goal/1", projectId: "loopit-workbench-m0", taskId: id, goalRevision: 1,
  objective: experiment === "owner-loss" ? "Prove a lost controller leaves a live unbilled Worker quarantined: cold unacknowledged-event replay creates no new writer, Supervisor stops dedicated identities, and a later scope rejects the old generation. No model, network or device action."
    : "Run a fixed unbilled long child through the production pause, cold recovery, explicit resume and cancel controls. No model, network or device action.",
  scope: { repositoryRef: pathToFileURL(`${finalRoot}/workspace`).href, baseRevision: baselineCommit, allowedPaths: ["fixture.txt"], excluded: ["model calls", "network clients", "devices", "prior run mutation"] },
  acceptance: [{ id: "CONTROL-01", expected: experiment === "owner-loss" ? "A real killed controller leaves a live old writer; cold replay does not prepare or start; independent dual-UID stop proofs retain the unknown reservation; old generation cannot launch in the next scope." : "Only verified independent dual-UID stop facts reach paused/cancelled; cold resume creates one new Attempt without renewing budget.", verification: "executable", evidenceKinds: ["control-matrix"], requiredAtStage: "verification" }],
  targetMatrix: [], delivery: { artifactKinds: ["control-matrix"] }, policyRef: ref("public/policy.json"),
  budgets: { wallMinutes: 10, maxRepairCycles: 3, maxParallelWriters: 1 }, costBudgetRef: ref("public/cost-policy.json"), resources: { fixtureRefs: [ref("public/catalog.json")], secretRefs: [] } }
const checked = parse("goal", goal)
if (!checked.ok || checkFrozen(checked.value).length) throw new Error("invalid_frozen_fixture_goal")
write("public/goal.json", JSON.stringify(goal, null, 2) + "\n")
const controllerName = experiment === "owner-loss" ? "owner-loss" : "control-matrix"
const controllerSource = resolve(import.meta.dir, `${controllerName}.ts`)
const result = await Bun.build({ entrypoints: [controllerSource], target: "bun", format: "esm", packages: "bundle", splitting: false, sourcemap: "none" })
if (!result.success || result.outputs.length !== 1) throw new Error(result.logs.map(String).join("\n"))
write(`bin/${controllerName}.mjs`, Buffer.from(await result.outputs[0].arrayBuffer()))
const protectedRunFiles = [["reports/result.json", "result.json"], ["reports/execution.json", "execution.json"], ["execution-budget.json", "runBudget.json"]].map(([relative, exported]) => {
  // Ordinary staging reads the root-exported copies. The installed controller
  // reads only the original root-protected bytes, never Documents or active.json.
  const source = join(proofExport, exported), stat = lstatSync(source)
  if (realpathSync(source) !== source || !stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error("unprotected_prior_run_export")
  return { path: join(prior, "control", relative), digest: sha(readFileSync(source)) }
})
const spec: ControlMatrixSpec & { experiment?: string } = { schemaVersion: "m0-control-matrix/1", jobId: id, runId: `run-${randomUUID()}`, ...(experiment === "owner-loss" ? { experiment } : {}),
  bun: pin("bin/bun"), executable: { ...pin("bin/unbilled-fixture"), version: "1.18.35" }, wrapper: pin("bin/worker-exec.py"), catalog: pin("public/catalog.json"), goal: pin("public/goal.json"),
  workspace: `${finalRoot}/workspace`, runtimeDirectory: `${finalRoot}/runtime`, controlDirectory: `${finalRoot}/control`, protectedRunFiles }
write("public/spec.json", JSON.stringify(spec, null, 2) + "\n")
const directories = [{ path: "", uid: 0, gid: 0, mode: 0o755 }, ...["bin", "public"].map((path) => ({ path, uid: 0, gid: 0, mode: 0o755 })),
  ...["control", "control/runtime-state", "control/reports"].map((path) => ({ path, uid: 0, gid: 0, mode: 0o700 })),
  ...["workspace", "runtime", ...["home", "config", "data", "cache", "state", "tmp"].map((sub) => `runtime/${sub}`)].map((path) => ({ path, uid: 420, gid: 420, mode: 0o700 })), ...gitDirectories]
const manifest = { schemaVersion: "m0-control-matrix-install/1", id, finalRoot, files, directories, spec,
  experiment, sourceDigests: { controller: sha(readFileSync(controllerSource)),
    protocol: experiment === "owner-loss" ? sha(readFileSync(resolve(import.meta.dir, "owner-loss-protocol.ts"))) : undefined,
    receipt: sha(readFileSync(resolve(import.meta.dir, "control-matrix-receipt.ts"))), fixture: sha(readFileSync(resolve(import.meta.dir, "control-matrix-fixture.ts"))) },
  baselineCommit, protectedRunFiles, priorRunDigestSource: proofExport, administratorActions: 0, modelCalls: 0, installationOccurred: false,
  invokeTwice: ["/usr/bin/python3", `${finalRoot}/bin/worker-supervisor.py`, "run", "--bun", spec.bun.path,
    "--controller", `${finalRoot}/bin/${controllerName}.mjs`, "--spec", `${finalRoot}/public/spec.json`, "--finalize", "--timeout-seconds", "120"],
  note: experiment === "owner-loss" ? "Two sequential invocations. First kills an owned child controller before ACK, verifies cold replay refuses a live old writer, then Supervisor alone stops dedicated UIDs. Second rejects a fixed old-generation no-op wrapper request. Unknown Runtime reservation remains quarantined. Shared fresh 10-minute fixture deadline; no model or device."
    : "Two sequential invocations under existing Supervisor. First must report paused before second is authorized; fresh 10-minute fixture budget is frozen once. No existing account, source, run or signer configuration is changed." }
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 })
console.log(JSON.stringify({ stage, finalRoot, manifest: join(stage, "manifest.json"), manifestDigest: sha(readFileSync(join(stage, "manifest.json"))), administratorActions: 0, modelCalls: 0 }))
