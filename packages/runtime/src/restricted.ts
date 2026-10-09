import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { digestOf } from "../../contracts/src"
import { seatbelt } from "../../sandbox/src/seatbelt"

export interface ExecutionBudget {
  /** Frozen by the trusted host for the entire GoalRevision, never reset per Attempt. */
  readonly deadlineAt: string
  readonly repairIndex: number
  readonly maxRepairs: 3
}
export interface RestrictedConfig {
  readonly readPaths: readonly string[]
  readonly editPaths: readonly string[]
  readonly agent: { readonly name: string; readonly steps: number }
  readonly model: { readonly provider: "openai"; readonly model: string; readonly variant: string }
  readonly catalog: { readonly path: string; readonly digest: string }
  /** Access-only in-memory credential. Neither the resolver nor its result is serialized. */
  readonly oauthAccess: () => Promise<{ access: string; expiresAt: number; accountId?: string }>
  readonly isolation: {
    readonly runtimeDirectory: string
    readonly childIdentity: { readonly uid: number; readonly gid: number }
    /** Protected, pinned Bun used only for the fixed kernel identity program. */
    readonly identityRuntime: { readonly path: string; readonly digest: string }
    readonly admission: { readonly scopeId: string; readonly generation: number }
    readonly launcher: { readonly argvPrefix: readonly string[]; readonly wrapperPath: string; readonly wrapperDigest: string }
    readonly denyRead: readonly string[]
    readonly proxyPort: number
  }
}
export interface RestrictedBinding { readonly configDigest: string; readonly permissionDigest: string }
const hash = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const overlaps = (a: string, b: string) => a === "/" || b === "/" || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
function paths(values: readonly string[]) {
  if (new Set(values).size !== values.length) throw new Error("duplicate permission paths")
  for (const path of values) {
    if (!path || isAbsolute(path) || path.split("/").some((part) => !part || part === "." || part === "..") || /[\\*?\[\]{}!\0\n\r]/.test(path))
      throw new Error("permissions require exact relative file paths without glob syntax")
  }
  return [...values].sort()
}
export function restrictedPermissions(config: Pick<RestrictedConfig, "readPaths" | "editPaths">) {
  const read = paths(config.readPaths), edit = paths(config.editPaths)
  if (!read.length || !edit.length || edit.some((path) => !read.includes(path))) throw new Error("edit paths must be a nonempty subset of read paths")
  return { "*": "deny", read: { "*": "deny", ...Object.fromEntries(read.map((path) => [path, "allow"])) },
    edit: { "*": "deny", ...Object.fromEntries(edit.map((path) => [path, "allow"])) }, external_directory: "deny" }
}
export function restrictedNativeConfig(config: RestrictedConfig) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(config.agent.name) || !Number.isSafeInteger(config.agent.steps) || config.agent.steps < 1 || config.agent.steps > 8)
    throw new Error("fixed native agent requires 1–8 steps")
  if (config.model.provider !== "openai" || !/^[a-zA-Z0-9._-]+$/.test(config.model.model) || !/^[a-zA-Z0-9._-]+$/.test(config.model.variant))
    throw new Error("invalid fixed model configuration")
  const model = `${config.model.provider}/${config.model.model}`, permission = restrictedPermissions(config)
  return { model, small_model: model, share: "disabled", autoupdate: false, formatter: false, lsp: false, mcp: {}, plugin: [], instructions: [],
    permission, agent: { [config.agent.name]: { mode: "primary", model, steps: config.agent.steps, permission } }, compaction: { auto: false, prune: false } }
}
/** Includes every public capability-setting field, never the OAuth resolver/result. */
export function restrictedConfigDigest(config: RestrictedConfig) {
  if (!config.isolation.identityRuntime || !isAbsolute(config.isolation.identityRuntime.path) ||
      !/^sha256:[0-9a-f]{64}$/.test(config.isolation.identityRuntime.digest)) throw new Error("pinned identity runtime required")
  if (!config.isolation.admission || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(config.isolation.admission.scopeId) ||
      !Number.isSafeInteger(config.isolation.admission.generation) || config.isolation.admission.generation < 1)
    throw new Error("fixed Supervisor scope/generation admission required")
  return digestOf({ schemaVersion: "opencode-restricted/1", nativeConfig: restrictedNativeConfig(config), variant: config.model.variant,
    catalog: config.catalog, isolation: config.isolation })
}
export function restrictedConfigBinding(config: RestrictedConfig): RestrictedBinding {
  return { configDigest: restrictedConfigDigest(config), permissionDigest: digestOf(restrictedPermissions(config)) }
}
export function remainingExecutionMs(budget: ExecutionBudget, now = Date.now()) {
  const deadline = Date.parse(budget.deadlineAt)
  if (!Number.isFinite(deadline) || new Date(deadline).toISOString() !== budget.deadlineAt || deadline <= now || deadline > now + 60 * 60_000 ||
      budget.maxRepairs !== 3 || !Number.isSafeInteger(budget.repairIndex) || budget.repairIndex < 0 || budget.repairIndex > 3)
    throw new Error("invalid/expired absolute 60-minute, three-repair execution budget")
  return deadline - now
}
function canonical(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) throw new Error("restricted paths must be absolute, canonical and free of symlinks")
  return path
}
function rejectAcl(path: string) {
  const result = spawnSync("/bin/ls", ["-lde", path], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 1_000, maxBuffer: 16_384 })
  if (result.status !== 0 || result.error || result.stdout.split(/\s+/)[0].includes("+")) throw new Error("restricted paths must have inspectable ACL-free permissions")
}
function protectedAncestors(path: string, inspectAcl: boolean) {
  for (let parent = dirname(path); parent !== "/"; parent = dirname(parent)) {
    if (inspectAcl) rejectAcl(parent)
    const ancestor = statSync(parent)
    // Root-owned sticky temporary roots are allowed; the protected subtree must
    // itself be non-writable. Sticky roots prevent another UID replacing it.
    if (ancestor.uid !== 0 || ((ancestor.mode & 0o022) !== 0 && (ancestor.mode & 0o1000) === 0)) throw new Error("trusted file has an unprotected ancestor")
  }
}
function protectedFile(path: string, digest: string, inspectAcl: boolean) {
  canonical(path)
  if (inspectAcl) rejectAcl(path)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || hash(readFileSync(path)) !== digest) throw new Error("trusted root-owned file pin/permissions mismatch")
  protectedAncestors(path, inspectAcl)
}
export function validateRestrictedLayout(config: RestrictedConfig, stateDirectory: string, workingDirectory: string, executable: string, executableDigest: string, inspectAcl = true) {
  if (process.platform !== "darwin" || process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw new Error("restricted mode requires a root controller on macOS")
  const state = canonical(stateDirectory), workspace = canonical(workingDirectory), runtime = canonical(config.isolation.runtimeDirectory)
  if (overlaps(state, workspace) || overlaps(state, runtime) || overlaps(workspace, runtime)) throw new Error("controller, runtime and candidate directories must be disjoint")
  for (const path of [state, runtime, workspace]) {
    if (inspectAcl) rejectAcl(path)
    protectedAncestors(path, inspectAcl)
  }
  const controller = statSync(state), child = statSync(runtime), candidate = statSync(workspace)
  const { uid, gid } = config.isolation.childIdentity
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid <= 0 || gid <= 0 || uid === process.getuid?.()) throw new Error("dedicated non-root child identity required")
  if (!controller.isDirectory() || controller.uid !== 0 || (controller.mode & 0o077) !== 0) throw new Error("controller state must be root-owned and private")
  if (!child.isDirectory() || child.uid !== uid || child.gid !== gid || (child.mode & 0o077) !== 0) throw new Error("child runtime must be dedicated-identity-owned and private")
  if (!candidate.isDirectory() || candidate.uid !== uid || candidate.gid !== gid || (candidate.mode & 0o022) !== 0) throw new Error("candidate ownership/permissions mismatch")
  protectedFile(executable, executableDigest, inspectAcl)
  protectedFile(config.catalog.path, config.catalog.digest, inspectAcl)
  protectedFile(config.isolation.identityRuntime.path, config.isolation.identityRuntime.digest, inspectAcl)
  protectedFile(config.isolation.launcher.wrapperPath, config.isolation.launcher.wrapperDigest, inspectAcl)
  const expected = ["/usr/bin/python3", config.isolation.launcher.wrapperPath, "--uid", String(uid), "--gid", String(gid), "--"]
  if (digestOf(config.isolation.launcher.argvPrefix) !== digestOf(expected)) throw new Error("fixed identity-drop launcher mismatch")
  for (const part of ["home", "config", "data", "cache", "state", "tmp"]) {
    const directory = canonical(join(runtime, part)), stat = statSync(directory)
    if (inspectAcl) rejectAcl(directory)
    if (!stat.isDirectory() || stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o077) !== 0) throw new Error("child runtime subdirectories must be pre-provisioned private directories")
  }
  for (const path of [...config.readPaths, ...config.editPaths]) {
    const target = join(workspace, path)
    if (realpathSync(target) !== target || !statSync(target).isFile()) throw new Error("registered permission paths must resolve to existing regular files")
  }
  // Constructing the command also validates canonical deny-read roots and proxy.
  restrictedCommand(config, state, workspace, ["/usr/bin/true"], {})
}
export function restrictedEnvironment(config: RestrictedConfig, base: Record<string, string>) {
  const directory = config.isolation.runtimeDirectory
  return { ...base, LOOPIT_SCOPE_ID: config.isolation.admission.scopeId, LOOPIT_GENERATION: String(config.isolation.admission.generation), HOME: join(directory, "home"), OPENCODE_TEST_HOME: join(directory, "home"),
    XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"), XDG_CACHE_HOME: join(directory, "cache"),
    XDG_STATE_HOME: join(directory, "state"), TMPDIR: join(directory, "tmp"), OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "2048",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(restrictedNativeConfig(config)), OPENCODE_MODELS_PATH: config.catalog.path,
    HTTP_PROXY: `http://127.0.0.1:${config.isolation.proxyPort}/`, HTTPS_PROXY: `http://127.0.0.1:${config.isolation.proxyPort}/`, ALL_PROXY: `http://127.0.0.1:${config.isolation.proxyPort}/` }
}
export function restrictedCommand(config: RestrictedConfig, state: string, workspace: string, argv: string[], env: Record<string, string>) {
  const command = seatbelt().command(argv, { workdir: workspace, writable: [config.isolation.runtimeDirectory],
    denyRead: [...new Set([state, ...config.isolation.denyRead])], network: { mode: "proxy", port: config.isolation.proxyPort }, env: { PATH: "/usr/bin:/bin", ...env } })
  return { ...command, argv: [...config.isolation.launcher.argvPrefix, ...command.argv] }
}
export async function resolveAccessEnvironment(config: RestrictedConfig, env: Record<string, string>) {
  let credential: Awaited<ReturnType<RestrictedConfig["oauthAccess"]>>
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    credential = await Promise.race([config.oauthAccess(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), 5_000)
    })])
  } catch { throw new Error("OAuth access-only resolver failed") } finally { clearTimeout(timer) }
  if (!credential || Object.keys(credential).some((key) => !["access", "expiresAt", "accountId"].includes(key)) ||
      typeof credential.access !== "string" || credential.access.length < 8 || !Number.isFinite(credential.expiresAt) || credential.expiresAt < Date.now() + 120_000 ||
      (credential.accountId !== undefined && typeof credential.accountId !== "string")) throw new Error("invalid access-only credential")
  const auth = { openai: { type: "oauth", access: credential.access, expires: credential.expiresAt, refresh: "", ...(credential.accountId ? { accountId: credential.accountId } : {}) } }
  return { env: { ...env, OPENCODE_AUTH_CONTENT: JSON.stringify(auth) }, secret: credential.access, expiresAt: credential.expiresAt }
}
export function assertEffectiveRestrictedConfig(config: RestrictedConfig, output: string) {
  let effective: Record<string, any>
  try { effective = JSON.parse(output) } catch { throw new Error("effective native config probe is not JSON") }
  const expected = restrictedNativeConfig(config)
  for (const key of ["permission", "model", "small_model", "formatter", "lsp", "mcp", "plugin", "instructions", "compaction"] as const)
    if (digestOf(effective[key]) !== digestOf(expected[key])) throw new Error(`effective native ${key} differs from trusted config`)
  const agent = effective.agent?.[config.agent.name]
  if (!agent || agent.mode !== "primary" || agent.model !== expected.model || agent.steps !== config.agent.steps || digestOf(agent.permission) !== digestOf(expected.permission))
    throw new Error("effective native agent differs from trusted config")
}

/** Incomplete capture is omitted entirely; a prefix of a token must never leak. */
export function redactCapturedOutput(chunks: readonly Buffer[], secret: string, truncated: boolean) {
  return truncated ? "[omitted: incomplete or truncated authenticated output]\n" : Buffer.concat(chunks).toString().split(secret).join("[REDACTED]")
}

/** Fixed, same-process Bun FFI program. Explicit symbol lookup avoids Darwin's
 * directory-service getgroups$DARWIN_EXTSN alias and any Python/xcrun shim. */
export const KERNEL_IDENTITY_FUNCTION = `import {dlopen,ptr} from 'bun:ffi';
function readKernelIdentity(){
 const library=dlopen('/usr/lib/libSystem.B.dylib',{getgroups:{args:['i32','ptr'],returns:'i32'}});
 try {
  const count=library.symbols.getgroups(0,null);
  if(!Number.isInteger(count)||count<0||count>1024)throw new Error('kernel group count invalid');
  const buffer=new Uint32Array(Math.max(1,count));
  const actual=library.symbols.getgroups(count,ptr(buffer));
  if(!Number.isInteger(actual)||actual<0||actual>count)throw new Error('kernel group read failed');
  return {uid:process.getuid(),euid:process.geteuid(),gid:process.getgid(),egid:process.getegid(),kernelGroups:Array.from(buffer.subarray(0,actual))};
 } finally {library.close()}
}`
export const KERNEL_IDENTITY_PROBE = `${KERNEL_IDENTITY_FUNCTION}\nconsole.log(JSON.stringify(readKernelIdentity()));`
export function assertKernelIdentity(output: string, uid: number, gid: number) {
  let value: any
  try { value = JSON.parse(output) } catch { throw new Error("kernel identity probe is not JSON") }
  if (value.uid !== uid || value.euid !== uid || value.gid !== gid || value.egid !== gid || !Array.isArray(value.kernelGroups) ||
      !value.kernelGroups.length || value.kernelGroups.some((group: unknown) => group !== gid)) throw new Error("child kernel identity/groups probe failed")
  return value as { uid: number; euid: number; gid: number; egid: number; kernelGroups: number[] }
}
