import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { digestOf, parse, type ContextManifest, type ExecutionSpec, type RuntimeCapabilities } from "../../contracts/src"
import { assertEffectiveRestrictedConfig, assertKernelIdentity, KERNEL_IDENTITY_PROBE, redactCapturedOutput, remainingExecutionMs, restrictedCommand, restrictedConfigBinding, restrictedEnvironment, resolveAccessEnvironment, validateRestrictedLayout, type ExecutionBudget, type RestrictedConfig } from "./restricted"

export interface CliOptions {
  readonly executable: string
  readonly executableDigest: string
  readonly version: string
  /** Controller-owned, persistent directory, outside the candidate working tree. */
  readonly stateDirectory: string
  readonly logLimitBytes?: number
  readonly restricted?: RestrictedConfig
}
export interface Handle { readonly attemptId: string; readonly operationId: string }
export interface StartInput { readonly spec: ExecutionSpec; readonly context: ContextManifest; readonly prompt: string; readonly executionBudget?: ExecutionBudget }
/** Opaque, single-use preparation receipt; structural lookalikes are rejected. */
export interface PreparedStart { readonly kind: "runtime-local-prepared" }
/** Trusted-host authorization, not proof generated or attested by this adapter.
 * The caller must first establish complete Supervisor UID/domain quiescence. */
export interface StoppedReservationAuthorization {
  readonly schemaVersion: "runtime-stopped-authorization/1"
  readonly nonce: string
  readonly stopProofDigest: string
  readonly workingDirectory: string
  readonly requestDigest: string
}
export interface StoppedReservationRelease {
  readonly status: "released"
  readonly alreadyReleased: boolean
  readonly handle: Handle
  readonly workingDirectory: string
  readonly requestDigest: string
  readonly authorizationDigest: string
  readonly reservationDigest: string
  readonly archivePath: string
}
export interface LocalEvent { readonly seq: number; readonly type: "started" | "output_delta" | "exited" | "failed"; readonly at: string; readonly data: unknown }
interface RecordState {
  schemaVersion: "runtime-local/1"
  handle: Handle
  requestDigest: string
  workingDirectory: string
  status: "reserved" | "running" | "exited" | "spawn_failed"
  pid?: number
  exitCode?: number | null
  signal?: string | null
  stopReason?: "cancel" | "pause" | "deadline"
  stoppedAttempt?: "interrupted_for_pause" | "cancelled" | "timed_out"
  logs: { stdoutBytes: number; stderrBytes: number; stdoutTruncated: boolean; stderrTruncated: boolean; pipesComplete: boolean; redactionPending?: boolean }
  events: LocalEvent[]
  persistenceErrors?: Array<{ phase: string; message: string }>
}
interface Live { child: ChildProcess; exited: boolean; deadline: ReturnType<typeof setTimeout>; record: RecordState }

const denyAll = { "*": "deny" }
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const validId = (id: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error("invalid identity") }
const hash = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const overlaps = (a: string, b: string) => a === "/" || b === "/" || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
const writeJson = (file: string, value: unknown) => {
  const temporary = `${file}.tmp-${process.pid}`
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
  renameSync(temporary, file)
}
const syncDirectory = (path: string) => {
  const fd = openSync(path, constants.O_RDONLY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
const boundedJson = (path: string) => {
  if (realpathSync(path) !== path) throw new Error("reconciliation input is symbolic or noncanonical")
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.size > 16_777_216) throw new Error("invalid reconciliation input file")
    const bytes = readFileSync(fd), after = fstatSync(fd)
    if (before.size !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino)
      throw new Error("reconciliation input changed")
    return { value: JSON.parse(bytes.toString()), digest: hash(bytes) }
  } finally { closeSync(fd) }
}

/** Local CLI lifecycle only. This is neither a persistent Supervisor nor a Gate. */
export class OpenCodeCli {
  private readonly live = new Map<string, Live>()
  private readonly limit: number
  private readonly root: string
  private readonly prepared = new WeakMap<PreparedStart, { digest: string; env?: Record<string, string>; secret?: string; expiresAt?: number }>()
  constructor(private readonly options: CliOptions) {
    if (process.platform === "win32") throw new Error("POSIX process groups required")
    if (!isAbsolute(options.executable) || !isAbsolute(options.stateDirectory)) throw new Error("absolute paths required")
    this.limit = options.logLimitBytes ?? 1_048_576
    if (!Number.isSafeInteger(this.limit) || this.limit < 1024 || this.limit > 16_777_216) throw new Error("invalid log limit")
    mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 })
    this.root = realpathSync(options.stateDirectory)
    for (const part of ["attempts", "operations", "reservations", "probe"]) mkdirSync(join(this.root, part), { recursive: true, mode: 0o700 })
  }
  private directory(id: string) { validId(id); return join(this.root, "attempts", id) }
  private save(record: RecordState) { writeJson(join(this.directory(record.handle.attemptId), "state.json"), record) }
  private notePersistenceError(record: RecordState, phase: string, error: unknown) {
    record.persistenceErrors ??= []
    if (record.persistenceErrors.length < 16) record.persistenceErrors.push({ phase, message: String(error) })
  }
  private saveAfterSpawn(record: RecordState, phase: string) {
    try { this.save(record); return true } catch (error) { this.notePersistenceError(record, phase, error); return false }
  }
  private owned(handle: Handle) {
    validId(handle.attemptId); validId(handle.operationId)
    const live = this.live.get(handle.attemptId)
    if (live && live.record.handle.operationId !== handle.operationId) throw new Error("operation identity mismatch")
    return live
  }
  private read(handle: Handle): RecordState {
    validId(handle.operationId)
    const record = JSON.parse(readFileSync(join(this.directory(handle.attemptId), "state.json"), "utf8")) as RecordState
    if (record.handle.operationId !== handle.operationId) throw new Error("operation identity mismatch")
    return record
  }
  private environment(directory: string): Record<string, string> {
    if (this.options.restricted) return restrictedEnvironment(this.options.restricted, {
      PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", CI: "1", OPENCODE_PURE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
    })
    for (const part of ["home", "config", "data", "cache", "state", "tmp"])
      mkdirSync(join(directory, part), { recursive: true, mode: 0o700 })
    return {
      HOME: join(directory, "home"), XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"),
      XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state"), TMPDIR: join(directory, "tmp"),
      PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", CI: "1", OPENCODE_PURE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: denyAll }),
    }
  }
  private pin() {
    if (hash(readFileSync(this.options.executable)) !== this.options.executableDigest) throw new Error("executable digest mismatch")
  }
  probe(): RuntimeCapabilities {
    if (this.options.restricted) throw new Error("restricted execution requires async prepareStart through its OS boundary")
    this.pin()
    const env = this.environment(join(this.root, "probe"))
    const run = (args: string[]) => {
      const result = spawnSync(this.options.executable, args, {
        cwd: join(this.root, "probe"), env, timeout: 5_000, maxBuffer: 65_536, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      })
      if (result.error || result.status !== 0) throw new Error(`CLI probe failed: ${result.error?.message ?? result.status}`)
      // OpenCode prints run --help to stderr even on a successful exit.
      return `${result.stdout}${result.stderr}`.trim()
    }
    const version = run(["--pure", "--version"])
    if (version !== this.options.version) throw new Error(`version mismatch: ${version}`)
    const help = run(["--pure", "run", "--help"])
    if (!help.includes("--format") || !help.includes("--model")) throw new Error("required CLI flags missing")
    writeJson(join(this.root, "probe", "cli.json"), { version, executable: this.options.executable, executableDigest: this.options.executableDigest, help })
    const unverified = { status: "unverified" as const, note: "No real model execution evidence" }
    return {
      schemaVersion: "runtime-capabilities/1", runtime: { name: "opencode", version }, probedAt: new Date().toISOString(),
      structuredEvents: unverified, images: { status: "unsupported" }, toolsMcp: { status: "unsupported", note: "Lifecycle slice uses deny-all tool permissions" },
      nativeResume: { status: "unsupported" }, checkpoint: { status: "unsupported" }, steer: { status: "unsupported" },
      cancelMode: { status: "limited", mode: "process-tree" },
      processTreeControl: { status: "limited", note: "POSIX group only; escaped descendants and external jobs cannot be proven stopped" },
      permissionModes: ["deny-all"], sandboxKinds: [], usageReporting: unverified, maxConcurrency: 1,
    }
  }
  async prepareStart(input: StartInput, operationId: string): Promise<PreparedStart> {
    validId(operationId)
    let stage = "input"
    let probeFailure: { reason: string; exitCode?: number | null; signal?: string | null } | undefined
    try {
      const requestDigest = digestOf({ input, operationId })
      stage = "pin"
      this.pin()
      const restricted = this.options.restricted
      if (restricted) {
        stage = "input"
        this.validateRestrictedInput(input)
        stage = "layout"
        validateRestrictedLayout(restricted, this.root, input.spec.workingDirectory, this.options.executable, this.options.executableDigest)
      }
      stage = "layout"
      const env = this.environment(join(this.root, "probe"))
      const run = (args: string[], executable = this.options.executable, stdoutOnly = false) => new Promise<string>((resolve, reject) => {
        probeFailure = undefined
        const command = restricted ? restrictedCommand(restricted, this.root, input.spec.workingDirectory, [executable, ...args], env) : { argv: [executable, ...args], env }
        const child = spawn(command.argv[0], command.argv.slice(1), {
          cwd: restricted ? input.spec.workingDirectory : join(this.root, "probe"), env: command.env, detached: true, stdio: ["ignore", "pipe", "pipe"],
        })
        let output = "", bytes = 0, settled = false
        const finish = (error?: Error) => {
          if (settled) return
          settled = true; clearTimeout(timer)
          if (error && child.pid) try {
            if (restricted) {
              // A root controller must never signal a numeric process group
              // after its leader has exited. Supervisor owns descendant cleanup.
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
            } else process.kill(-child.pid, "SIGKILL")
          } catch { /* Already exited; full-UID cleanup remains Supervisor-owned. */ }
          child.stdout.destroy(); child.stderr.destroy()
          if (error) reject(error); else resolve(output.trim())
        }
        const timer = setTimeout(() => { probeFailure = { reason: "timeout" }; finish(new Error("CLI preparation probe timed out")) }, 5_000)
        for (const [index, stream] of [child.stdout, child.stderr].entries()) stream.on("data", (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 65_536) { probeFailure = { reason: "output_limit" }; finish(new Error("CLI preparation probe output exceeds limit")) }
          else if (!stdoutOnly || index === 0) output += chunk.toString()
        })
        child.on("error", (error) => { if (!settled) probeFailure = { reason: "spawn_error" }; finish(error) })
        child.on("close", (code, signal) => {
          if (!settled && code !== 0) probeFailure = { reason: "exit_failure", exitCode: code, signal }
          finish(code === 0 ? undefined : new Error(`CLI preparation probe failed: ${code}`))
        })
      })
      if (restricted) {
        stage = "identity"
        const { uid, gid } = restricted.isolation.childIdentity
        assertKernelIdentity(await run(["--eval", KERNEL_IDENTITY_PROBE], restricted.isolation.identityRuntime.path, true), uid, gid)
      }
      stage = "version"
      const version = await run(["--pure", "--version"])
      if (version !== this.options.version) throw new Error("version mismatch")
      stage = "help"
      const help = await run(["--pure", "run", "--help"])
      if (!help.includes("--format") || !help.includes("--model")) throw new Error("required CLI flags missing")
      stage = "config"
      if (restricted) assertEffectiveRestrictedConfig(restricted, await run(["--pure", "debug", "config"], this.options.executable, true))
      stage = "auth"
      const access = restricted ? await resolveAccessEnvironment(restricted, env) : undefined
      stage = "input"
      if (restricted) this.validateRestrictedInput(input)
      // Bind the bytes before probing. The caller cannot swap input while these
      // asynchronous processes run and then use the receipt for the changed input.
      if (requestDigest !== digestOf({ input, operationId })) throw new Error("preparation input changed")
      stage = "config"
      writeJson(join(this.root, "probe", "cli.json"), { version, executable: this.options.executable,
        executableDigest: this.options.executableDigest, help })
      const token = Object.freeze({ kind: "runtime-local-prepared" as const })
      this.prepared.set(token, { digest: requestDigest, ...access })
      return token
    } catch (error) {
      // Fixed metadata only. Never serialize probe output, input, environment,
      // debug config, auth errors, or arbitrary exception text. Diagnostics are
      // best effort and cannot replace the original fail-closed exception.
      const fixedMessages = new Set([
        "executable digest mismatch", "version mismatch", "required CLI flags missing", "preparation input changed",
        "restricted execution requires a frozen absolute execution budget", "invalid/expired absolute 60-minute, three-repair execution budget",
        "unregistered model", "restricted effective config binding mismatch", "restricted mode requires a root controller on macOS",
        "restricted paths must be absolute, canonical and free of symlinks", "restricted paths must have inspectable ACL-free permissions",
        "controller, runtime and candidate directories must be disjoint", "trusted file has an unprotected ancestor",
        "dedicated non-root child identity required", "controller state must be root-owned and private",
        "child runtime must be dedicated-identity-owned and private", "candidate ownership/permissions mismatch",
        "trusted root-owned file pin/permissions mismatch", "fixed identity-drop launcher mismatch",
        "child runtime subdirectories must be pre-provisioned private directories", "registered permission paths must resolve to existing regular files",
        "kernel identity probe is not JSON", "child kernel identity/groups probe failed", "effective native config probe is not JSON",
        "effective native agent differs from trusted config", ...["permission", "model", "small_model", "formatter", "lsp", "mcp", "plugin", "instructions", "compaction"].map((key) => `effective native ${key} differs from trusted config`),
      ])
      const message = error instanceof Error && fixedMessages.has(error.message) ? error.message : undefined
      const code = (error as NodeJS.ErrnoException)?.code
      const systemCode = typeof code === "string" && ["EACCES", "EPERM", "ENOENT", "EIO", "ENOSPC", "EEXIST", "ENOTDIR", "EISDIR", "EMFILE", "ENFILE", "EINVAL", "ENOMEM"].includes(code) ? code : undefined
      const failure = stage === "auth" ? { reason: "authentication_preparation_failed" } : {
        reason: "preparation_failed", errorClass: error instanceof TypeError ? "TypeError" : error instanceof SyntaxError ? "SyntaxError" : "Error",
        ...(message ? { message } : {}), ...(systemCode ? { systemCode } : {}), ...(probeFailure ? { probe: probeFailure } : {}),
      }
      try { writeJson(join(this.root, "probe", `preparation-${operationId}.json`), {
        schemaVersion: "runtime-preparation-diagnostic/1", operationId, stage, status: "failed", observedAt: new Date().toISOString(), failure,
      }) } catch { /* Preserve original error; unavailable evidence is not success. */ }
      throw error
    }
  }
  startPrepared(input: StartInput, operationId: string, token: PreparedStart): Handle {
    const prepared = this.prepared.get(token)
    if (!prepared || prepared.digest !== digestOf({ input, operationId })) throw new Error("invalid or changed preparation identity")
    this.prepared.delete(token)
    // Rehash the fixed executable inside final authorization. No subprocess
    // probe runs here, but binary/input hashing and local file I/O still do.
    this.pin()
    if (this.options.restricted) {
      this.validateRestrictedInput(input)
      if (!prepared.expiresAt || prepared.expiresAt < Date.now() + 30_000) throw new Error("prepared OAuth access expired")
      validateRestrictedLayout(this.options.restricted, this.root, input.spec.workingDirectory, this.options.executable, this.options.executableDigest, false)
    }
    return this.startInternal(input, operationId, () => {}, prepared)
  }
  start(input: StartInput, operationId: string): Handle {
    if (this.options.restricted) throw new Error("restricted execution requires async prepareStart")
    return this.startInternal(input, operationId, () => { this.probe() })
  }
  private validateRestrictedInput(input: StartInput) {
    const config = this.options.restricted!
    if (!input.executionBudget) throw new Error("restricted execution requires a frozen absolute execution budget")
    remainingExecutionMs(input.executionBudget)
    if (input.spec.model.provider !== config.model.provider || input.spec.model.model !== config.model.model) throw new Error("unregistered model")
    const binding = restrictedConfigBinding(config)
    const expected = [
      { kind: "instruction", ref: "input://frozen-goal", digest: digestOf(input.prompt) },
      { kind: "permission", ref: "config://restricted-permissions", digest: binding.permissionDigest },
      { kind: "model", ref: "config://model", digest: digestOf(input.spec.model) },
      { kind: "model", ref: "config://opencode-restricted", digest: binding.configDigest },
      { kind: "instruction", ref: "config://execution-budget", digest: digestOf(input.executionBudget) },
    ]
    if (digestOf(input.context.effectiveConfig) !== digestOf(expected)) throw new Error("restricted effective config binding mismatch")
  }
  private startInternal(input: StartInput, operationId: string, probe: () => void,
    prepared?: { env?: Record<string, string>; secret?: string; expiresAt?: number }): Handle {
    validId(operationId)
    const parsed = parse("execution", input.spec)
    const context = parse("context", input.context)
    if (!parsed.ok || !context.ok) throw new Error("invalid execution/context contract")
    const { spec } = input
    validId(spec.attemptId)
    if (spec.runtime.name !== "opencode" || spec.runtime.version !== this.options.version) throw new Error("runtime pin mismatch")
    if (spec.runtime.sourceDigest && spec.runtime.sourceDigest !== this.options.executableDigest) throw new Error("runtime digest mismatch")
    if (spec.nativeSessionRef) throw new Error("native resume unsupported; create a new Attempt")
    if (input.context.attemptId !== spec.attemptId || digestOf(input.context) !== spec.contextManifest.digest) throw new Error("context binding mismatch")
    if (![input.context.policy.ref, `${input.context.policy.ref}#${input.context.policy.digest}`].includes(spec.policyRef)) throw new Error("policy binding mismatch")
    const config = input.context.effectiveConfig
    const required = { instruction: digestOf(input.prompt), permission: digestOf(denyAll), model: digestOf(spec.model) }
    if (this.options.restricted) this.validateRestrictedInput(input)
    else if (config.length !== 3 || Object.entries(required).some(([kind, digest]) => !config.some((entry) => entry.kind === kind && entry.digest === digest)))
      throw new Error("effective config must bind exactly the supplied prompt, model and deny-all permissions")
    if (input.context.toolCapabilities.length || input.context.knowledgeRefs.length || input.context.historyRefs.length || input.context.appended?.length)
      throw new Error("tool/knowledge/history input resolution is not implemented")
    if (!input.prompt.trim() || input.context.budget.wallMinutesRemaining === 0) throw new Error("prompt and remaining wall budget required")
    if (!isAbsolute(spec.workingDirectory)) throw new Error("absolute working directory required")
    const workingDirectory = realpathSync(spec.workingDirectory)
    if (overlaps(this.root, workingDirectory))
      throw new Error("state and candidate workspace must not contain one another")
    const handle = { attemptId: spec.attemptId, operationId }
    const requestDigest = digestOf({ input, operationId })
    const directory = this.directory(spec.attemptId)
    if (existsSync(join(directory, "state.json"))) {
      const prior = this.read(handle)
      if (prior.requestDigest !== requestDigest) throw new Error("Attempt identity reused for a different request")
      return prior.handle
    }
    if ([...this.live.values()].some((entry) => !entry.exited)) throw new Error("local runtime concurrency limit reached")
    // Serialize filesystem admission across Adapter instances/processes. A crash
    // while holding this lock blocks new starts until Supervisor reconciliation.
    const admissionPath = join(this.root, "admission.lock")
    const admission = openSync(admissionPath, "wx", 0o600)
    try {
      for (const file of readdirSync(join(this.root, "reservations"))) {
        const reservation = JSON.parse(readFileSync(join(this.root, "reservations", file), "utf8")) as { workingDirectory: string; handle: Handle }
        const prior = reservation.workingDirectory
        if (overlaps(prior, workingDirectory))
          throw new Error("workspace overlaps a quarantined reservation")
        // A leader exit or empty process group cannot exclude escaped descendants
        // and external jobs. Every unreleased reservation still owns the slot.
        // Only explicit trusted-host stop reconciliation may release it.
        throw new Error("runtime concurrency slot retained until independent safety reconciliation")
      }
      probe()
      // The reservation precedes spawn. Crashes at any following point leave the
      // workspace blocked, even if no PID receipt was recorded. Never auto-unlock.
      const lock = join(this.root, "reservations", hash(workingDirectory).slice(7) + ".json")
      const operation = join(this.root, "operations", operationId + ".json")
      const operationFd = openSync(operation, "wx", 0o600)
      try { writeFileSync(operationFd, JSON.stringify({ handle, requestDigest })) } finally { closeSync(operationFd) }
      const descriptor = openSync(lock, "wx", 0o600)
      try { writeFileSync(descriptor, JSON.stringify({ handle, requestDigest, workingDirectory })) } finally { closeSync(descriptor) }
      mkdirSync(directory, { mode: 0o700 })
      const record: RecordState = {
        schemaVersion: "runtime-local/1", handle, requestDigest, workingDirectory, status: "reserved", events: [],
        logs: { stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false, pipesComplete: false, ...(this.options.restricted ? { redactionPending: true } : {}) },
      }
      this.save(record)
      writeJson(join(directory, "input.json"), input)
      const env = prepared?.env ?? this.environment(directory)
      // Required evidence destinations must be writable before any process starts.
      for (const name of ["stdout", "stderr"]) writeFileSync(join(directory, `${name}.log`), "", { mode: 0o600 })
      const args = [this.options.executable, "--pure", "run", "--format", "json", "--model", `${spec.model.provider}/${spec.model.model}`]
      const restricted = this.options.restricted
      if (restricted) args.push("--agent", restricted.agent.name, "--variant", restricted.model.variant)
      const command = restricted ? restrictedCommand(restricted, this.root, workingDirectory, args, env) : { argv: args, env }
      const timeoutMs = Math.min(Math.min(spec.budget.wallMinutes, input.context.budget.wallMinutesRemaining) * 60_000,
        input.executionBudget ? remainingExecutionMs(input.executionBudget) : Infinity, prepared?.expiresAt ? prepared.expiresAt - Date.now() - 5_000 : Infinity)
      if (timeoutMs <= 0) throw new Error("execution deadline expired before dispatch")
      const child = spawn(command.argv[0], command.argv.slice(1), {
        cwd: workingDirectory, env: command.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
      })
      // Access-bearing subprocess output never reaches disk incrementally. Only a
      // complete bounded stream can be redacted safely across chunk boundaries.
      const buffered = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
      const flushRestricted = () => {
        if (!restricted) return
        for (const name of ["stdout", "stderr"] as const) try {
          const bytes = redactCapturedOutput(buffered[name], prepared!.secret!, record.logs[`${name}Truncated`])
          writeFileSync(join(directory, `${name}.log`), bytes, { mode: 0o600 })
        } catch (error) { this.notePersistenceError(record, `redacted_log:${name}`, error) }
        record.logs.redactionPending = false
      }
      let storageStopRequested = false
      const stopOnStorageFailure = () => {
        if (storageStopRequested || this.live.get(handle.attemptId)?.exited) return
        storageStopRequested = true
        void this.cancel(handle).catch((error: unknown) => this.notePersistenceError(record, "storage_failure_stop", error))
      }
      const add = (type: LocalEvent["type"], data: unknown) => {
        if (record.events.length < 256) record.events.push({ seq: record.events.length + 1, type, at: new Date().toISOString(), data })
        if (!this.saveAfterSpawn(record, `event:${type}`)) stopOnStorageFailure()
      }
      const live: Live = {
        child, record, exited: false,
        deadline: setTimeout(() => {
          void this.cancel(handle, "deadline").catch((error: unknown) => {
            // Keep the reservation even when evidence storage/stop fails. Report
            // the failure to the host without creating an unhandled rejection.
            process.emitWarning(`Runtime deadline stop failed for ${handle.attemptId}: ${String(error)}`)
            try { add("failed", { phase: "deadline_stop", message: String(error) }) } catch { /* Host warning remains the fallback evidence. */ }
          })
        }, timeoutMs),
      }
      this.live.set(spec.attemptId, live)
      child.on("spawn", () => { record.pid = child.pid; record.status = "running"; add("started", { pid: child.pid, promptAcknowledged: false }) })
      child.on("error", (error) => { live.exited = true; clearTimeout(live.deadline); record.status = "spawn_failed"; add("failed", { message: error.message }) })
      child.on("exit", (code, signal) => {
        live.exited = true; clearTimeout(live.deadline); record.status = "exited"; record.exitCode = code; record.signal = signal
        if (record.stopReason) record.stoppedAttempt = record.stopReason === "pause" ? "interrupted_for_pause" : record.stopReason === "deadline" ? "timed_out" : "cancelled"
        add("exited", { code, signal, gate: "not_evaluated" })
        // Escaped descendants may retain stdout/stderr after their parent exits.
        // Stop reading after a fixed grace period; collect never waits for close.
        const timer = setTimeout(() => {
          for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) {
            if (!stream.readableEnded) record.logs[`${name}Truncated`] = true
            stream.destroy()
          }
          flushRestricted()
          this.saveAfterSpawn(record, "pipe_grace_expired")
        }, 100)
        timer.unref()
      })
      child.on("close", () => { record.logs.pipesComplete = !!child.stdout?.readableEnded && !!child.stderr?.readableEnded; flushRestricted(); this.saveAfterSpawn(record, "pipes_closed") })
      for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) {
        stream.on("data", (chunk: Buffer) => {
          const previous = record.logs[`${name}Bytes`]
          record.logs[`${name}Bytes`] += chunk.length
          try {
            if (previous < this.limit) {
              if (restricted) buffered[name].push(Buffer.from(chunk.subarray(0, this.limit - previous)))
              else writeFileSync(join(directory, `${name}.log`), chunk.subarray(0, this.limit - previous), { flag: "a" })
            }
          } catch (error) {
            record.logs[`${name}Truncated`] = true
            this.notePersistenceError(record, `log:${name}`, error)
          }
          if (previous + chunk.length > this.limit) record.logs[`${name}Truncated`] = true
          this.saveAfterSpawn(record, `log_metadata:${name}`)
          if (record.persistenceErrors?.length) stopOnStorageFailure()
        })
      }
      child.stdin.on("error", () => { /* Early child exit: the exit/error event records the outcome. */ })
      child.stdin.end(input.prompt)
      return handle
    } finally {
      closeSync(admission)
      unlinkSync(admissionPath)
    }
  }
  inspect(handle: Handle) {
    const live = this.owned(handle)
    const record = live?.record ?? this.read(handle)
    let group: "alive" | "absent" | "unknown" = "unknown"
    if (live && record.pid) {
      try { process.kill(-record.pid, 0); group = "alive" } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") group = "absent" }
    }
    const persistenceErrors = structuredClone(record.persistenceErrors ?? [])
    return { ...structuredClone(record), persistenceErrors, evidence: { available: persistenceErrors.length === 0 },
      ownership: live ? "local" as const : "unknown" as const, processGroup: group, safeToRedispatch: false as const, gate: "not_evaluated" as const }
  }
  async *observe(handle: Handle, cursor = 0): AsyncGenerator<LocalEvent> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("invalid cursor")
    while (true) {
      const record = this.owned(handle)?.record ?? this.read(handle)
      for (const event of record.events) if (event.seq > cursor) { cursor = event.seq; yield event }
      if (record.status === "exited" || record.status === "spawn_failed" || !this.live.has(handle.attemptId)) return
      await delay(25)
    }
  }
  async cancel(handle: Handle, reason: "cancel" | "pause" | "deadline" = "cancel") {
    const live = this.owned(handle)
    if (!live) return { requested: false, reason: "ownership_unknown", observed: this.inspect(handle) }
    if (live.exited) return { requested: false, reason: "leader_already_exited", observed: this.inspect(handle) }
    live.record.stopReason = reason
    // Known local ownership is enough for an emergency stop. A full disk or
    // unreadable receipt must not prevent signalling that owned process group.
    this.saveAfterSpawn(live.record, "stop_intent")
    // Only signal a child owned by this live process; recovered PIDs can be reused.
    if (!live.exited && !live.record.pid) await delay(25)
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const observed = this.inspect(handle)
      if (observed.processGroup === "absent") break
      if (observed.pid) try { process.kill(-observed.pid, signal) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return { requested: true, reason: "signal_failed", observed: this.inspect(handle) }
      }
      const until = Date.now() + 250
      while (Date.now() < until && this.inspect(handle).processGroup !== "absent") await delay(25)
    }
    return { requested: true, reason, observed: this.inspect(handle) }
  }
  reconcile(handle: Handle) { return { decision: "quarantine" as const, reason: "Full descendant and external-side-effect reconciliation requires Supervisor", observed: this.inspect(handle) } }
  /** Release exactly one stopped pure-code reservation. No PID is signalled and
   * no native process is resumed. Unknown states and external-tool inputs retain
   * their reservation. Operations, Attempt state, input and logs remain intact. */
  releaseStoppedReservation(handle: Handle, authorization: StoppedReservationAuthorization): StoppedReservationRelease {
    for (const value of [handle?.attemptId, handle?.operationId, authorization?.nonce]) {
      if (typeof value !== "string") throw new Error("invalid reconciliation identity")
      validId(value)
    }
    if (!authorization || Object.keys(authorization).sort().join(",") !== "nonce,requestDigest,schemaVersion,stopProofDigest,workingDirectory" ||
        authorization.schemaVersion !== "runtime-stopped-authorization/1" ||
        !/^sha256:[0-9a-f]{64}$/.test(authorization.stopProofDigest) || !/^sha256:[0-9a-f]{64}$/.test(authorization.requestDigest) ||
        typeof authorization.workingDirectory !== "string" || !isAbsolute(authorization.workingDirectory) ||
        realpathSync(authorization.workingDirectory) !== authorization.workingDirectory)
      throw new Error("invalid trusted stop authorization")
    const authorizationDigest = digestOf({ handle, authorization })
    const admissionPath = join(this.root, "admission.lock"), admission = openSync(admissionPath, "wx", 0o600)
    try {
      const rootOwner = lstatSync(this.root).uid
      const privateDirectory = (path: string) => {
        const info = lstatSync(path)
        if (realpathSync(path) !== path || !info.isDirectory() || info.uid !== rootOwner || (info.mode & 0o777) !== 0o700)
          throw new Error("reconciliation directory is not private controller state")
      }
      privateDirectory(this.root)
      const reconciliations = join(this.root, "reconciliations"), archive = join(reconciliations, authorization.nonce)
      const authorizationPath = join(archive, "authorization.json"), archivePath = join(archive, "reservation.json")
      const reservationPath = join(this.root, "reservations", hash(authorization.workingDirectory).slice(7) + ".json")
      const priorAuthorization = existsSync(authorizationPath) ? boundedJson(authorizationPath).value : undefined
      if (priorAuthorization && (priorAuthorization.authorizationDigest !== authorizationDigest ||
          digestOf(priorAuthorization.authorization) !== digestOf(authorization) || digestOf(priorAuthorization.handle) !== digestOf(handle)))
        throw new Error("reconciliation nonce reused for different authorization")
      const result = (reservationDigest: string, alreadyReleased: boolean): StoppedReservationRelease => ({ status: "released", alreadyReleased,
        handle: { ...handle }, workingDirectory: authorization.workingDirectory, requestDigest: authorization.requestDigest,
        authorizationDigest, reservationDigest, archivePath })
      if (existsSync(archivePath)) {
        privateDirectory(reconciliations); privateDirectory(archive)
        const archived = boundedJson(archivePath)
        if (!priorAuthorization || priorAuthorization.reservationDigest !== archived.digest ||
            digestOf(archived.value) !== digestOf({ handle, requestDigest: authorization.requestDigest, workingDirectory: authorization.workingDirectory }))
          throw new Error("archived reconciliation differs from the exact reservation")
        if (existsSync(reservationPath) && digestOf(boundedJson(reservationPath).value.handle) === digestOf(handle))
          throw new Error("released reservation reappeared; independent reconciliation required")
        // Replaying an already completed authorization cannot release a newer
        // reservation or interfere with a subsequently admitted child.
        return result(archived.digest, true)
      }
      if ([...this.live.values()].some((entry) => !entry.exited)) throw new Error("local child is still live; reservation retained")
      if (!this.options.restricted) throw new Error("release requires a registered restricted pure-code configuration")
      const state = boundedJson(join(this.directory(handle.attemptId), "state.json"))
      const inputFile = boundedJson(join(this.directory(handle.attemptId), "input.json"))
      const operation = boundedJson(join(this.root, "operations", handle.operationId + ".json"))
      const reservation = boundedJson(reservationPath)
      const record = state.value as RecordState, input = inputFile.value as StartInput
      if (record.schemaVersion !== "runtime-local/1" || digestOf(record.handle) !== digestOf(handle) ||
          !["exited", "spawn_failed"].includes(record.status) || record.workingDirectory !== authorization.workingDirectory ||
          record.requestDigest !== authorization.requestDigest || record.persistenceErrors?.length ||
          record.logs?.pipesComplete !== true || record.logs.redactionPending === true ||
          digestOf(operation.value) !== digestOf({ handle, requestDigest: authorization.requestDigest }) ||
          digestOf(reservation.value) !== digestOf({ handle, requestDigest: authorization.requestDigest, workingDirectory: authorization.workingDirectory }))
        throw new Error("reservation/state/operation are not the exact completed execution")
      if (!parse("execution", input.spec).ok || !parse("context", input.context).ok || input.spec.nativeSessionRef || !input.executionBudget ||
          input.spec.attemptId !== handle.attemptId || input.context.attemptId !== handle.attemptId ||
          input.spec.workingDirectory !== authorization.workingDirectory || input.spec.contextManifest.digest !== digestOf(input.context) ||
          digestOf({ input, operationId: handle.operationId }) !== authorization.requestDigest || input.context.toolCapabilities.length ||
          input.context.knowledgeRefs.length || input.context.historyRefs.length || input.context.appended?.length)
        throw new Error("release input is not the exact restricted pure-code request")
      const oldConfig = input.context.effectiveConfig.find((entry) => entry.kind === "model" && entry.ref === "config://opencode-restricted")
      const expected = [
        { kind: "instruction", ref: "input://frozen-goal", digest: digestOf(input.prompt) },
        { kind: "permission", ref: "config://restricted-permissions", digest: restrictedConfigBinding(this.options.restricted).permissionDigest },
        { kind: "model", ref: "config://model", digest: digestOf(input.spec.model) },
        { kind: "model", ref: "config://opencode-restricted", digest: oldConfig?.digest },
        { kind: "instruction", ref: "config://execution-budget", digest: digestOf(input.executionBudget) },
      ]
      if (!oldConfig || !/^sha256:[0-9a-f]{64}$/.test(oldConfig.digest) || digestOf(input.context.effectiveConfig) !== digestOf(expected))
        throw new Error("original restricted permission boundary is not unchanged pure-code access")
      const evidence = { schemaVersion: "runtime-reservation-reconciliation/1", handle, authorization, authorizationDigest,
        reservationDigest: reservation.digest, stateDigest: state.digest, inputDigest: inputFile.digest, operationDigest: operation.digest }
      if (priorAuthorization && digestOf(priorAuthorization) !== digestOf(evidence)) throw new Error("pending reconciliation evidence changed")
      if (!existsSync(reconciliations)) { mkdirSync(reconciliations, { mode: 0o700 }); syncDirectory(this.root) }
      privateDirectory(reconciliations)
      if (!existsSync(archive)) { mkdirSync(archive, { mode: 0o700 }); syncDirectory(reconciliations) }
      privateDirectory(archive)
      if (!priorAuthorization) {
        const fd = openSync(authorizationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { writeFileSync(fd, JSON.stringify(evidence)); fsyncSync(fd) } finally { closeSync(fd) }
        syncDirectory(archive)
      }
      // The durable authorization precedes the atomic move. A crash before the
      // move retains the reservation; afterward both authorization and original
      // reservation bytes are available for exact same-authorization replay.
      renameSync(reservationPath, archivePath)
      syncDirectory(archive); syncDirectory(join(this.root, "reservations"))
      return result(reservation.digest, false)
    } finally { closeSync(admission); unlinkSync(admissionPath) }
  }
  collect(handle: Handle) {
    // Validate the handle before touching files, while preserving local emergency
    // access when the on-disk state is unreadable.
    this.owned(handle) ?? this.read(handle)
    const directory = this.directory(handle.attemptId)
    const artifacts = ["stdout.log", "stderr.log", "input.json", "state.json"].map((name) => {
      const path = join(directory, name)
      try { return { path, available: true, digest: hash(readFileSync(path)) } } catch (error) {
        const live = this.owned(handle)
        if (live) this.notePersistenceError(live.record, `collect:${name}`, error)
        return { path, available: false, error: String(error) }
      }
    })
    const observed = this.inspect(handle)
    if (artifacts.some((artifact) => !artifact.available)) observed.evidence.available = false
    return { observed, promptAcknowledged: "unverified" as const, settled: "unverified" as const, gate: "not_evaluated" as const,
      usage: { known: false, reason: "Provider usage has not been independently measured" },
      artifacts }
  }
  async dispose(handle: Handle) {
    const stopped = await this.cancel(handle)
    return { cleaned: false, reservationRetained: true, artifactsRetained: true, observed: stopped.observed }
  }
  sendInput() { return { supported: false, reason: "CLI stdin closes after the initial prompt; new input requires a new Attempt" } as const }
  checkpoint() { return { supported: false, reason: "Native checkpoint unsupported; immutable input and logs retained" } as const }
}
