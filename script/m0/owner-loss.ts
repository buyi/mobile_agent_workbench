/** Finite no-model A06 experiment. A lost root controller is killed only via its
 * parent's live ChildProcess; only Supervisor may stop dedicated Worker UIDs. */
import { spawn, spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Writable } from "node:stream"
import { Effect } from "effect"
import { checkFrozen, digestOf, parse } from "../../packages/contracts/src"
import { Delivery, WorkerDispatch } from "../../packages/delivery/src"
import {
  OpenCodeCli,
  restrictedConfigBinding,
  type ExecutionBudget,
  type RestrictedConfig,
} from "../../packages/runtime/src"
import type { ControlMatrixSpec } from "./control-matrix"
import { controlMatrixProofs } from "./control-matrix-authority"
import { readFreshFixtureReceipt } from "./control-matrix-receipt"
import { coldOwnerLossReplay, holdUnacknowledgedStart, maintainChildLiveness } from "./owner-loss-protocol"

const sha = (value: Buffer | string) => `sha256:${createHash("sha256").update(value).digest("hex")}`
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"))
function protectedPath(path: string) {
  if (realpathSync(path) !== path) throw new Error("owner_loss_noncanonical_input")
  for (let at = path; ; at = dirname(at)) {
    const st = lstatSync(at)
    if (st.uid !== 0 || st.mode & 0o022) throw new Error("owner_loss_unprotected_input")
    if (at === "/") break
  }
}
function save(path: string, value: unknown) {
  // Publish only complete bytes. link is atomic and refuses an existing target,
  // preserving immutable evidence while avoiding an exists-before-write race.
  const temporary = path + ".tmp-" + randomUUID(),
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n")
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    linkSync(temporary, path)
  } finally {
    unlinkSync(temporary)
  }
  const parent = openSync(dirname(path), constants.O_RDONLY)
  try {
    fsyncSync(parent)
  } finally {
    closeSync(parent)
  }
}
function inventory() {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,uid=,ruid=,stat="], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    encoding: "utf8",
    timeout: 2000,
    maxBuffer: 1_048_576,
  })
  if (result.error || result.signal || result.status !== 0) throw new Error("owner_loss_inventory_unavailable")
  return result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const parts = line.trim().split(/\s+/)
      if (parts.length !== 5 || parts.slice(0, 4).some((x) => !/^\d+$/.test(x)))
        throw new Error("owner_loss_inventory_invalid")
      return {
        pid: Number(parts[0]),
        ppid: Number(parts[1]),
        uid: Number(parts[2]),
        ruid: Number(parts[3]),
        state: parts[4],
      }
    })
    .filter((p) => p.uid === 420 || p.ruid === 420)
}
async function main() {
  if (process.platform !== "darwin" || process.getuid?.() !== 0 || process.geteuid?.() !== 0)
    throw new Error("root_owner_loss_controller_required")
  const args = new Map<string, string>()
  for (let i = 2; i < process.argv.length; i += 2) {
    if (
      !["--phase", "--spec", "--scope", "--generation", "--stop-proof"].includes(process.argv[i]) ||
      !process.argv[i + 1] ||
      args.has(process.argv[i])
    )
      throw new Error("invalid_arguments")
    args.set(process.argv[i], process.argv[i + 1])
  }
  const phase = args.get("--phase")!,
    scopeId = args.get("--scope")!,
    generation = Number(args.get("--generation")),
    lock = Number(process.env.LOOPIT_SUPERVISOR_LOCK_FD)
  if (
    !["execute", "child", "finalize"].includes(phase) ||
    !/^[a-f0-9-]{36}$/.test(scopeId) ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  )
    throw new Error("invalid_scope")
  const lockPath = "/private/var/loopit/supervisor/ownership.lock"
  protectedPath(lockPath)
  const lockStat = lstatSync(lockPath),
    held = fstatSync(lock)
  if (lock < 3 || held.uid !== 0 || !held.isFile() || held.dev !== lockStat.dev || held.ino !== lockStat.ino)
    throw new Error("ownership_descriptor_missing")
  // A root child must not survive its experiment parent. EOF and a short
  // heartbeat timeout both exit this controller without fabricating Worker exit.
  if (phase === "child") maintainChildLiveness(4)
  const specPath = args.get("--spec")!
  protectedPath(specPath)
  const spec = read(specPath) as ControlMatrixSpec & { experiment: string }
  if (spec.schemaVersion !== "m0-control-matrix/1" || spec.experiment !== "owner-loss")
    throw new Error("invalid_owner_loss_spec")
  for (const pin of [spec.bun, spec.executable, spec.wrapper, spec.catalog, spec.goal]) {
    protectedPath(pin.path)
    if (sha(readFileSync(pin.path)) !== pin.digest) throw new Error("owner_loss_pin_changed")
  }
  protectedPath(spec.controlDirectory)
  const priorPins = () => {
    for (const pin of spec.protectedRunFiles) {
      protectedPath(pin.path)
      if (sha(readFileSync(pin.path)) !== pin.digest) throw new Error("original_model_run_changed")
    }
    return spec.protectedRunFiles
  }
  priorPins()
  const active = () => {
    const path = "/private/var/loopit/supervisor/active.json"
    protectedPath(path)
    return read(path)
  }
  const current = active()
  if (
    current.scopeId !== scopeId ||
    current.generation !== generation ||
    current.phase !== (phase === "finalize" ? "finalizing" : "running")
  )
    throw new Error("owner_loss_scope_mismatch")
  const reports = join(spec.controlDirectory, "reports"),
    budgetPath = join(spec.controlDirectory, "execution-budget.json")
  mkdirSync(reports, { recursive: true, mode: 0o700 })
  if (!existsSync(budgetPath)) {
    if (phase !== "execute") throw new Error("owner_loss_budget_missing")
    save(budgetPath, { deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(), repairIndex: 0, maxRepairs: 3 })
  }
  const budget = read(budgetPath) as ExecutionBudget
  if (Date.parse(budget.deadlineAt) <= Date.now()) throw new Error("owner_loss_budget_expired")
  const parsed = parse("goal", read(spec.goal.path))
  if (!parsed.ok || checkFrozen(parsed.value).length) throw new Error("owner_loss_goal_invalid")
  const goal = parsed.value
  const restricted: RestrictedConfig = {
    readPaths: ["fixture.txt"],
    editPaths: ["fixture.txt"],
    agent: { name: "owner-loss-fixture", steps: 1 },
    model: { provider: "openai", model: "unbilled-fixture", variant: "low" },
    catalog: spec.catalog,
    oauthAccess: async () => ({ access: "NO_MODEL_FIXTURE_CREDENTIAL", expiresAt: Date.now() + 60 * 60_000 }),
    isolation: {
      runtimeDirectory: spec.runtimeDirectory,
      identityRuntime: spec.bun,
      childIdentity: { uid: 420, gid: 420 },
      admission: { scopeId, generation },
      launcher: {
        argvPrefix: ["/usr/bin/python3", spec.wrapper.path, "--uid", "420", "--gid", "420", "--"],
        wrapperPath: spec.wrapper.path,
        wrapperDigest: spec.wrapper.digest,
      },
      denyRead: [spec.controlDirectory, "/private/var/loopit/signer"],
      proxyPort: 1,
    },
  }
  const state = join(spec.controlDirectory, "runtime-state"),
    adapter = new OpenCodeCli({
      executable: spec.executable.path,
      executableDigest: spec.executable.digest,
      version: spec.executable.version,
      stateDirectory: state,
      restricted,
    })
  let preparations = 0,
    starts = 0
  if (phase !== "child") {
    adapter.prepareStart = async () => {
      preparations++
      throw new Error("cold_preparation_forbidden")
    }
    adapter.startPrepared = () => {
      starts++
      throw new Error("cold_spawn_forbidden")
    }
  }
  const layer = WorkerDispatch.layerFromPath(join(spec.controlDirectory, "delivery.sqlite"), {
    adapter,
    launch: () => ({
      workingDirectory: spec.workspace,
      runtime: { name: "opencode", version: spec.executable.version, sourceDigest: spec.executable.digest },
      model: { provider: "openai", model: "unbilled-fixture" },
      wallMinutes: 10,
      restrictedBinding: restrictedConfigBinding(restricted),
      executionBudget: budget,
    }),
  })
  const readyPath = join(reports, "unacknowledged-start.json"),
    firstPath = join(reports, "owner-lost-stopped.json")
  const reservation = () => {
    const names = readdirSync(join(state, "reservations"))
    if (names.length !== 1) throw new Error("exact_reservation_missing")
    const path = join(state, "reservations", names[0])
    protectedPath(path)
    return { path, digest: sha(readFileSync(path)), value: read(path) }
  }
  if (phase === "child") {
    const baseline = readdirSync(spec.workspace),
      notBefore = Date.now()
    await Effect.runPromise(
      Effect.gen(function* () {
        const worker = yield* WorkerDispatch.Service,
          delivery = yield* Delivery.Service
        for (const command of [
          { type: "createTask", expectedVersion: 0, goal },
          { type: "startRun", expectedVersion: 1, runId: spec.runId },
        ]) {
          const result = yield* delivery.execute({
            schemaVersion: "command/1",
            commandId: randomUUID(),
            actor: { kind: "system", id: "owner-loss-child" },
            issuedAt: new Date().toISOString(),
            taskId: goal.taskId,
            ...command,
          })
          if (result.kind !== "receipt" || result.receipt.status !== "accepted")
            throw new Error("owner_loss_start_rejected")
        }
        yield* holdUnacknowledgedStart(worker, delivery, spec.runId, async (record, item) => {
          const until = Date.now() + 10000
          while (true) {
            const observed = adapter.inspect(record.handle)
            if (observed.pid && existsSync(join(spec.workspace, `receipt-${observed.pid}.json`))) break
            if (["exited", "spawn_failed"].includes(observed.status) || Date.now() > until)
              throw new Error("owner_loss_fixture_not_ready")
            await Bun.sleep(20)
          }
          const childReceipt = readFreshFixtureReceipt({
            directory: spec.workspace,
            record,
            existingNames: baseline,
            notBefore,
            inspect: () => adapter.inspect(record.handle),
          })
          save(readyPath, {
            scopeId,
            generation,
            record,
            item,
            childReceipt,
            reservation: reservation(),
            budget,
            outboxAcknowledged: false,
            modelCalls: 0,
            usesActualOpenCodeExecutable: false,
          })
        })
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
    throw new Error("owner_loss_child_unexpected_return")
  }
  if (phase === "execute" && !existsSync(firstPath)) {
    if (existsSync(readyPath)) throw new Error("owner_loss_previous_incomplete_scope_quarantined")
    const output = openSync(
      join(reports, `child-controller-${scopeId}.log`),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    )
    const controller = join(dirname(spec.bun.path), "owner-loss.mjs")
    protectedPath(controller)
    const child = spawn(
      spec.bun.path,
      [controller, "--phase", "child", "--spec", specPath, "--scope", scopeId, "--generation", String(generation)],
      {
        cwd: spec.controlDirectory,
        env: { ...process.env, LOOPIT_SUPERVISOR_LOCK_FD: "3" },
        stdio: ["ignore", output, output, lock, "pipe"],
      },
    )
    closeSync(output)
    const pipe = child.stdio[4] as Writable
    pipe.on("error", () => {})
    const heartbeat = setInterval(() => {
      if (!pipe.destroyed) pipe.write(".")
    }, 250)
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.on("exit", (code, signal) => resolve({ code, signal }))
      child.on("error", reject)
    })
    let termination: { code: number | null; signal: string | null }
    try {
      const until = Date.now() + 20000
      while (!existsSync(readyPath)) {
        if (child.exitCode !== null || child.signalCode !== null || Date.now() > until)
          throw new Error("owner_loss_child_controller_not_ready")
        await Bun.sleep(25)
      }
      if (!child.kill("SIGKILL")) throw new Error("owner_loss_owned_child_kill_failed")
      termination = await exited
      if (termination.signal !== "SIGKILL") throw new Error("owner_loss_child_not_killed")
    } finally {
      clearInterval(heartbeat)
      pipe.destroy()
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await exited
    }
    const ready = read(readyPath),
      before = inventory()
    if (
      !before.some(
        (p) => p.pid === ready.childReceipt.receipt.pid && p.uid === 420 && p.ruid === 420 && !p.state.startsWith("Z"),
      )
    )
      throw new Error("old_writer_not_live_after_controller_loss")
    const replay = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* coldOwnerLossReplay(yield* WorkerDispatch.Service, yield* Delivery.Service, ready)
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
    const after = inventory(),
      retained = reservation()
    if (
      preparations ||
      starts ||
      digestOf(retained) !== digestOf(ready.reservation) ||
      !after.some((p) => p.pid === ready.childReceipt.receipt.pid && !p.state.startsWith("Z"))
    )
      throw new Error("owner_loss_replay_spawned_or_lost_writer")
    save(join(reports, `execute-${scopeId}.json`), {
      mode: "controller-loss",
      scopeId,
      generation,
      termination,
      before,
      after,
      replay,
      preparations,
      starts,
      reservation: retained,
      budget,
      priorRunPinsUnchanged: priorPins(),
      modelCalls: 0,
      usesActualOpenCodeExecutable: false,
    })
  } else if (phase === "execute") {
    const old = read(firstPath),
      ready = read(readyPath)
    if (
      current.priorStopProofs?.scopeId !== old.scopeId ||
      current.priorStopProofs?.generation !== old.generation ||
      generation <= old.generation ||
      scopeId === old.scopeId
    )
      throw new Error("owner_loss_stale_scope_binding_invalid")
    const result = spawnSync(
      "/usr/bin/python3",
      [
        spec.wrapper.path,
        "--uid",
        "420",
        "--gid",
        "420",
        "--",
        "/usr/bin/sandbox-exec",
        "-p",
        "(version 1)(allow default)(deny network*)",
        "/usr/bin/true",
      ],
      {
        cwd: spec.workspace,
        env: { PATH: "/usr/bin:/bin", LOOPIT_SCOPE_ID: old.scopeId, LOOPIT_GENERATION: String(old.generation) },
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 8192,
      },
    )
    if (
      result.error ||
      result.signal ||
      result.status === 0 ||
      !result.stderr.includes("Stale or missing launch scope/generation")
    )
      throw new Error("old_generation_not_explicitly_rejected")
    const processes = inventory()
    if (processes.some((p) => !p.state.startsWith("Z")) || digestOf(reservation()) !== digestOf(ready.reservation))
      throw new Error("stale_scope_launched_or_released")
    const observed = adapter.inspect(ready.record.handle)
    if (observed.ownership !== "unknown" || observed.status !== "running" || observed.safeToRedispatch !== false)
      throw new Error("unknown_execution_was_rewritten")
    save(join(reports, `execute-${scopeId}.json`), {
      mode: "old-generation",
      scopeId,
      generation,
      oldScopeId: old.scopeId,
      oldGeneration: old.generation,
      fixedProbe: {
        command: "sandbox-exec /usr/bin/true",
        status: result.status,
        reason: "Stale or missing launch scope/generation",
      },
      processes,
      observed,
      reservation: reservation(),
      budget,
      priorRunPinsUnchanged: priorPins(),
      modelCalls: 0,
      usesActualOpenCodeExecutable: false,
    })
  } else {
    const pair = controlMatrixProofs(active(), scopeId, generation),
      provided = args.get("--stop-proof")!
    protectedPath(provided)
    if (digestOf(read(provided)) !== digestOf(pair.worker)) throw new Error("owner_loss_stop_file_mismatch")
    const ready = read(readyPath),
      observed = adapter.inspect(ready.record.handle),
      retained = reservation(),
      execution = read(join(reports, `execute-${scopeId}.json`))
    if (
      observed.status !== "running" ||
      observed.ownership !== "unknown" ||
      observed.safeToRedispatch !== false ||
      digestOf(retained) !== digestOf(ready.reservation)
    )
      throw new Error("unknown_reservation_not_retained")
    save(
      join(reports, execution.mode === "controller-loss" ? "owner-lost-stopped.json" : "old-generation-rejected.json"),
      {
        scopeId,
        generation,
        pair,
        execution,
        observed,
        reservation: retained,
        budget,
        status: "quarantined-with-independent-stop-proof",
        nativeExitFabricated: false,
        reservationReleased: false,
        gate: "not_evaluated",
        priorRunPinsUnchanged: priorPins(),
        modelCalls: 0,
        usesActualOpenCodeExecutable: false,
      },
    )
  }
  console.log(JSON.stringify({ status: "owner_loss_phase_complete", phase, scopeId, generation, modelCalls: 0 }))
}
if (
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href || process.argv[1].endsWith("/owner-loss.mjs"))
)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "owner_loss_failed")
    process.exitCode = 1
  })
