/** Finite, unbilled Supervisor conformance probe. Run only by the root Supervisor.
 * Two dedicated-UID fixtures survive controller exit, including a setsid child.
 * The Supervisor (not this controller) must stop them before finalize can pass.
 */
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assertKernelIdentity, KERNEL_IDENTITY_FUNCTION, KERNEL_IDENTITY_PROBE } from "../../packages/runtime/src/restricted"
import type { ControlLoopSpec } from "./control-loop"

const digest = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"))
function protectedPath(path: string) {
  if (realpathSync(path) !== path) throw new Error("noncanonical_trusted_probe_input")
  for (let part = path; ; part = dirname(part)) {
    const st = lstatSync(part)
    if (st.uid !== 0 || (st.mode & 0o022)) throw new Error("unprotected_trusted_probe_input")
    if (part === "/") break
  }
}
function save(path: string, value: unknown) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd) } finally { closeSync(fd) }
}
function workerReceipt(path: string, scopeId: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== 420 || stat.nlink !== 1 || stat.size > 4096) throw new Error("invalid_worker_probe_receipt")
    const value = JSON.parse(readFileSync(fd, "utf8"))
    if (value.scopeId !== scopeId || !Number.isSafeInteger(value.pid) || value.pid < 2) throw new Error("probe_receipt_scope_mismatch")
    return value as { scopeId: string; pid: number; uid: number; gid: number; kernelIdentity: { uid: number; euid: number; gid: number; egid: number; kernelGroups: number[] }; descendantPid?: number }
  } finally { closeSync(fd) }
}
function inventory() {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,uid=,ruid=,stat="], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, encoding: "utf8", timeout: 1000, maxBuffer: 1_048_576 })
  if (result.error || result.signal || result.status !== 0) throw new Error("process_inventory_failed")
  return result.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const values = line.trim().split(/\s+/)
    if (values.length !== 6 || values.slice(0, 5).some((value) => !/^\d+$/.test(value))) throw new Error("unrecognized_process_inventory")
    return { pid: Number(values[0]), ppid: Number(values[1]), pgid: Number(values[2]), uid: Number(values[3]), ruid: Number(values[4]), state: values[5] }
  })
}
export function expectedAdmissionDenial(result: { status: number | null; signal: string | null; error?: unknown; stderr: string }, reason: "scope" | "phase") {
  const message = reason === "scope" ? "RuntimeError: Stale or missing launch scope/generation" : "RuntimeError: Launch phase or registered identity does not match"
  return !result.error && !result.signal && result.status === 1 && result.stderr.split(/\r?\n/).some((line) => line === message)
}
export function validateProbeProof(proof: Record<string, unknown>, scopeId: string, generation: number) {
  if (proof.schemaVersion !== "worker-stop-proof/1" || proof.scopeId !== scopeId || proof.generation !== generation || proof.workerUid !== 420 ||
      proof.observedUid !== 420 || proof.observedGid !== 420 || proof.noLiveWorkerProcesses !== true || proof.userDomainAbsent !== true || proof.externalActionsVerified !== false)
    throw new Error("probe_stop_proof_invalid")
}

async function main() {
  if (process.platform !== "darwin" || process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw new Error("root_probe_controller_required")
  const args = new Map<string, string>()
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!process.argv[i + 1] || args.has(process.argv[i])) throw new Error("invalid_arguments")
    args.set(process.argv[i], process.argv[i + 1])
  }
  const phase = args.get("--phase"), scopeId = args.get("--scope")!, generation = Number(args.get("--generation"))
  if (!["execute", "finalize"].includes(phase!) || !/^[a-f0-9-]{36}$/.test(scopeId) || !Number.isSafeInteger(generation) || generation < 1) throw new Error("invalid_probe_scope")
  const lock = Number(process.env.LOOPIT_SUPERVISOR_LOCK_FD)
  if (!Number.isSafeInteger(lock) || lock < 3 || fstatSync(lock).uid !== 0 || !fstatSync(lock).isFile()) throw new Error("supervisor_lock_missing")
  const specPath = args.get("--spec")!; protectedPath(specPath)
  const spec = json(specPath) as ControlLoopSpec
  if (spec.schemaVersion !== "m0-control-loop/1") throw new Error("invalid_probe_spec")
  for (const pin of [spec.bun, spec.wrapper]) {
    protectedPath(pin.path)
    if (digest(readFileSync(pin.path)) !== pin.digest) throw new Error("probe_binary_pin_changed")
  }
  protectedPath(spec.controlDirectory)
  const reports = join(spec.controlDirectory, "reports"); mkdirSync(reports, { recursive: true, mode: 0o700 })
  const prefix = `.supervisor-probe-${scopeId}`
  const leaderPath = join(spec.workspace, `${prefix}-leader.json`), descendantPath = join(spec.workspace, `${prefix}-descendant.json`)
  const executedPath = join(reports, `supervisor-probe-${scopeId}-execute.json`)
  const candidatePath = join(spec.workspace, "sumEvenThrough.ts")
  const env = { PATH: "/usr/bin:/bin", HOME: join(spec.runtimeDirectory, "home"), TMPDIR: join(spec.runtimeDirectory, "tmp"),
    LOOPIT_SCOPE_ID: scopeId, LOOPIT_GENERATION: String(generation) }
  const argv = (command: string[]) => [spec.wrapper.path, "--uid", "420", "--gid", "420", "--", "/usr/bin/sandbox-exec", "-p",
    "(version 1)(allow default)(deny network*)", ...command]
  const diagnostics: string[] = []
  const wrapperCheck = (name: string, command: string[], scope = scopeId, epoch = generation) => {
    const result = spawnSync("/usr/bin/python3", argv(command), { cwd: spec.workspace,
      env: { ...env, LOOPIT_SCOPE_ID: scope, LOOPIT_GENERATION: String(epoch) }, timeout: 1500, encoding: "utf8", maxBuffer: 8192 })
    const path = join(reports, `supervisor-probe-${scopeId}-${phase}-${name}.json`)
    save(path, { name, status: result.status, signal: result.signal, error: result.error ? { name: result.error.name, code: (result.error as NodeJS.ErrnoException).code } : null,
      stdout: result.stdout?.slice(-2048) ?? "", stderr: result.stderr?.slice(-4096) ?? "", truncated: (result.stdout?.length ?? 0) > 2048 || (result.stderr?.length ?? 0) > 4096 })
    diagnostics.push(path)
    return result
  }
  const requireDenied = (name: string, scope: string, epoch: number, reason: "scope" | "phase") => {
    const result = wrapperCheck(name, ["/usr/bin/true"], scope, epoch)
    if (!expectedAdmissionDenial(result, reason)) throw new Error(`admission_negative_inconclusive:${name}:status=${result.status}:stderr=${result.stderr?.slice(-600) ?? ""}`)
  }
  if (phase === "execute") {
    const candidateBefore = digest(readFileSync(candidatePath))
    for (const [name, flag, expected] of [["positive-uid", "-u", "420"], ["positive-gid", "-g", "420"]] as const) {
      const result = wrapperCheck(name, ["/usr/bin/id", flag])
      const actual = result.stdout?.trim().split(/\s+/) ?? []
      if (result.error || result.signal || result.status !== 0 || actual.length === 0 || actual.some((value) => value !== expected))
        throw new Error(`positive_wrapper_identity_failed:${name}:status=${result.status}:stderr=${result.stderr?.slice(-600) ?? ""}`)
    }
    const kernel = wrapperCheck("positive-kernel-identity", [spec.bun.path, "--eval", KERNEL_IDENTITY_PROBE])
    if (kernel.error || kernel.signal || kernel.status !== 0) throw new Error(`positive_kernel_identity_failed:status=${kernel.status}:stderr=${kernel.stderr?.slice(-600) ?? ""}`)
    assertKernelIdentity(kernel.stdout, 420, 420)
    requireDenied("wrong-scope", "old-" + scopeId, generation, "scope")
    requireDenied("wrong-generation", scopeId, generation + 1, "scope")
    const fixtureIdentity = `${KERNEL_IDENTITY_FUNCTION}
const kernelIdentity=readKernelIdentity();
if(kernelIdentity.uid!==420||kernelIdentity.euid!==420||kernelIdentity.gid!==420||kernelIdentity.egid!==420||!kernelIdentity.kernelGroups.length||kernelIdentity.kernelGroups.some(g=>g!==420))throw new Error('fixture_kernel_identity_failed');`
    const descendantSource = `import {writeFileSync} from 'node:fs';${fixtureIdentity}
writeFileSync(${JSON.stringify(descendantPath)},JSON.stringify({scopeId:${JSON.stringify(scopeId)},pid:process.pid,uid:process.getuid(),gid:process.getgid(),kernelIdentity}),{flag:'wx',mode:0o600});
process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`
    const leaderSource = `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';${fixtureIdentity}
const child=spawn(process.execPath,['--eval',${JSON.stringify(descendantSource)}],{detached:true,stdio:['ignore','inherit','inherit'],env:process.env});child.unref();
writeFileSync(${JSON.stringify(leaderPath)},JSON.stringify({scopeId:${JSON.stringify(scopeId)},pid:process.pid,descendantPid:child.pid,uid:process.getuid(),gid:process.getgid(),kernelIdentity}),{flag:'wx',mode:0o600});
process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`
    const capture = { stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
      pid: undefined as number | undefined, exitCode: null as number | null, signal: null as string | null, closed: false, spawnError: undefined as string | undefined }
    const child = spawn("/usr/bin/python3", argv([spec.bun.path, "--eval", leaderSource]), { cwd: spec.workspace, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) stream.on("data", (chunk: Buffer) => {
      capture[`${name}Bytes`] += chunk.length
      capture[name] = (capture[name] + chunk.toString()).slice(-8192)
      capture[`${name}Truncated`] = capture[`${name}Bytes`] > 8192
    })
    child.on("error", (error) => { capture.spawnError = error.message })
    child.on("exit", (code, signal) => { capture.exitCode = code; capture.signal = signal })
    child.on("close", () => { capture.closed = true })
    await new Promise<void>((resolve) => { child.once("spawn", resolve); child.once("error", () => resolve()) })
    capture.pid = child.pid
    child.unref()
    const deadline = Date.now() + 3000
    let leader: ReturnType<typeof workerReceipt> | undefined, descendant: ReturnType<typeof workerReceipt> | undefined, receiptError = ""
    while (Date.now() < deadline) {
      try { leader = workerReceipt(leaderPath, scopeId); descendant = workerReceipt(descendantPath, scopeId); break }
      catch (error) { receiptError = error instanceof Error ? error.message : "receipt read failed"; if (capture.closed || capture.spawnError) break; await Bun.sleep(20) }
    }
    const capturePath = join(reports, `supervisor-probe-${scopeId}-leader-diagnostics.json`)
    save(capturePath, { ...capture, leaderReceiptAvailable: !!leader, descendantReceiptAvailable: !!descendant, receiptError })
    diagnostics.push(capturePath)
    // Pipes may be held by the escaped descendant. They must not keep this
    // finite root controller alive; all unbounded lifetime belongs to Supervisor.
    child.stdout.destroy(); child.stderr.destroy()
    if (!leader || !descendant || leader.descendantPid !== descendant.pid || [leader, descendant].some((item) => item.uid !== 420 || item.gid !== 420 || item.kernelIdentity.kernelGroups.some((gid) => gid !== 420)))
      throw new Error(`dedicated_worker_probe_not_ready:code=${capture.exitCode}:signal=${capture.signal}:stderr=${capture.stderr.slice(-600)}:receipt=${receiptError}`)
    assertKernelIdentity(JSON.stringify(leader.kernelIdentity), 420, 420); assertKernelIdentity(JSON.stringify(descendant.kernelIdentity), 420, 420)
    const processes = inventory(), parent = processes.find((item) => item.pid === leader!.pid), escaped = processes.find((item) => item.pid === descendant!.pid)
    if (!parent || !escaped || parent.uid !== 420 || parent.ruid !== 420 || escaped.uid !== 420 || escaped.ruid !== 420 ||
        parent.pgid === escaped.pgid || escaped.pgid !== escaped.pid) throw new Error("setsid_escape_not_observed")
    save(executedPath, { schemaVersion: "supervisor-probe-execute/1", scopeId, generation, sourceDigest: digest(readFileSync(spec.source.path)), candidateDigest: candidateBefore,
      leader, descendant, diagnostics, kernelObservation: [parent, escaped], invalidScopeRejected: true, invalidGenerationRejected: true,
      fixture: "no model/network/device calls; dedicated-UID process lifecycle only" })
    console.log(JSON.stringify({ phase, scopeId, status: "fixtures_running_controller_exits", escapedDescendantObserved: true }))
    return
  }
  const proofPath = args.get("--stop-proof")!; protectedPath(proofPath)
  const proof = json(proofPath); validateProbeProof(proof, scopeId, generation)
  const executed = json(executedPath)
  if (executed.scopeId !== scopeId || executed.generation !== generation || executed.schemaVersion !== "supervisor-probe-execute/1") throw new Error("probe_execute_binding_invalid")
  if (inventory().some((item) => (item.uid === 420 || item.ruid === 420) && !item.state.startsWith("Z"))) throw new Error("worker_process_survived_supervisor_stop")
  requireDenied("late-worker-phase", scopeId, generation, "phase")
  requireDenied("late-old-scope", "old-" + scopeId, generation, "scope")
  requireDenied("late-wrong-generation", scopeId, generation + 1, "scope")
  if (digest(readFileSync(spec.source.path)) !== executed.sourceDigest || digest(readFileSync(candidatePath)) !== executed.candidateDigest) throw new Error("probe_changed_source")
  for (const path of [leaderPath, descendantPath]) { workerReceipt(path, scopeId); unlinkSync(path) }
  save(join(reports, "supervisor-probe.json"), { schemaVersion: "supervisor-probe/1", status: "passed", scopeId, generation,
    executedReceipt: executedPath, diagnostics, stopProof: { path: proofPath, digest: digest(readFileSync(proofPath)) },
    escapedDescendantObserved: true, workerUidInventoryEmpty: true, lateWorkerPhaseRejected: true,
    oldScopeRejected: true, wrongGenerationRejected: true, sourceUnchanged: true, workspaceReceiptsCleaned: true,
    modelRequests: 0, networkRequests: 0, deviceOperations: 0, proofScope: "exclusive-local-UID-processes-only" })
  console.log(JSON.stringify({ phase, scopeId, status: "passed", report: join(reports, "supervisor-probe.json") }))
}
if (process.argv[1] && (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith("supervisor-probe.mjs"))) {
  main().catch((error) => { console.error(JSON.stringify({ status: "blocked", reason: error instanceof Error ? error.message : "probe failed" })); process.exitCode = 2 })
}
