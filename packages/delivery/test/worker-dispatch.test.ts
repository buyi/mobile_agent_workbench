import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { digestOf, parse } from "@loopit/contracts"
import { OpenCodeCli, type Handle } from "../../runtime/src"
import type { Delivery } from "../src"
import { cmd, exec, goal, withService } from "./helpers"
import { fixtureSource, setup, spawnCount, until, withWorker } from "./worker-fixture"

const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function tracked() {
  const f = setup(), handles: Handle[] = [], start = f.adapter.startPrepared.bind(f.adapter)
  f.adapter.startPrepared = (input, operationId, token) => { const handle = start(input, operationId, token); handles.push(handle); return handle }
  cleanups.push(async () => { for (const handle of handles) await f.adapter.cancel(handle) })
  return f
}
const startTask = (delivery: Delivery.Interface, objective = "fixture hold") => Effect.gen(function* () {
  yield* exec(delivery, cmd.create({ goal: goal({ objective }) }))
  yield* exec(delivery, cmd.start(1, "run-1"))
})

describe("committed Delivery outbox to local Runtime (no model calls or delivery Gate)", () => {
  test("one committed Run produces one bound execution; duplicate/concurrent events reuse its handle", async () => {
    const f = tracked()
    let launches = 0
    await withWorker(f.file, { adapter: f.adapter, launch: () => { launches++; return f.launch } }, (worker, delivery) => Effect.gen(function* () {
      yield* startTask(delivery)
      let startItem: Delivery.OutboxItem | undefined
      yield* delivery.drainOutbox((item) => Effect.gen(function* () {
        if (item.envelope.eventType === "loopit.run.started") startItem = item
        yield* worker.consume(item).pipe(Effect.orDie)
      }))
      const first = (yield* worker.get("run-1"))!
      expect(parse("execution", first.input!.spec).ok).toBe(true)
      expect(parse("context", first.input!.context).ok).toBe(true)
      expect(first.input!.context.goal.digest).toBe(digestOf((yield* delivery.getTask("task-1"))!.revisions[1].goal))
      expect(first.input!.spec.contextManifest.digest).toBe(digestOf(first.input!.context))
      const duplicates = yield* Effect.all(Array.from({ length: 4 }, () => worker.consume(startItem!)), { concurrency: "unbounded" })
      expect(duplicates.every((result) => digestOf(result.record!.handle) === digestOf(first.handle))).toBe(true)
      yield* Effect.promise(() => until(() => spawnCount(f.launch.workingDirectory) === 1))
      yield* worker.inspect("run-1")
      expect((yield* delivery.getRun("run-1"))!.status).toBe("running")
      expect(spawnCount(f.launch.workingDirectory)).toBe(1)
      expect(launches).toBe(1)
      const forged = { ...startItem!, envelope: { ...startItem!.envelope, eventId: "invented" } }
      expect(Exit.isFailure(yield* worker.consume(forged).pipe(Effect.exit))).toBe(true)
    }))
  })

  test("reserved does not report running; actual exit remains waiting for independent verification", async () => {
    const f = tracked()
    await withWorker(f.file, { adapter: f.adapter, launch: () => f.launch }, (worker, delivery) => Effect.gen(function* () {
      yield* startTask(delivery, "fixture exit")
      yield* worker.drain()
      const record = (yield* worker.get("run-1"))!
      yield* Effect.promise(() => until(() => f.adapter.inspect(record.handle).status === "exited"))
      const observed = yield* worker.inspect("run-1")
      expect(observed.gate).toBe("not_evaluated")
      expect(observed.record!.observed!.safeToRedispatch).toBe(false)
      expect((yield* delivery.getRun("run-1"))!.status).toBe("waiting")
      expect((yield* delivery.getRun("run-1"))!.history.every((entry) => entry.to !== "succeeded")).toBe(true)
    }))
  })

  for (const control of ["pause", "cancel"] as const)
    test(`${control} consumes the real control event and stops the child without claiming complete reconciliation`, async () => {
      const f = tracked()
      await withWorker(f.file, { adapter: f.adapter, launch: () => f.launch }, (worker, delivery) => Effect.gen(function* () {
        yield* startTask(delivery)
        yield* worker.drain()
        const record = (yield* worker.get("run-1"))!
        yield* Effect.promise(() => until(() => spawnCount(f.launch.workingDirectory) === 1))
        yield* worker.inspect("run-1")
        const task = (yield* delivery.getTask("task-1"))!
        yield* exec(delivery, control === "pause" ? cmd.pause(task.version, "run-1") : cmd.cancel(task.version, "run-1"))
        yield* worker.drain()
        const observed = f.adapter.inspect(record.handle)
        expect(observed.status).toBe("exited")
        expect(observed.processGroup).toBe("absent")
        expect(observed.safeToRedispatch).toBe(false)
        expect((yield* delivery.getRun("run-1"))!.status).toBe(control === "pause" ? "pausing" : "cancelling")
        expect(spawnCount(f.launch.workingDirectory)).toBe(1)
      }))
    })

  test("a pause committed before start delivery suppresses spawning", async () => {
    const f = tracked()
    await withWorker(f.file, { adapter: f.adapter, launch: () => f.launch }, (worker, delivery) => Effect.gen(function* () {
      yield* startTask(delivery)
      yield* exec(delivery, cmd.pause(2, "run-1"))
      yield* worker.drain()
      expect((yield* worker.get("run-1"))!.phase).toBe("suppressed")
      expect(spawnCount(f.launch.workingDirectory)).toBe(0)
      expect((yield* delivery.getRun("run-1"))!.status).toBe("pausing")
    }))
  })

  test("invalid launch contracts are recorded as blocked and never spawn", async () => {
    const f = tracked()
    await withWorker(f.file, { adapter: f.adapter, launch: () => ({ ...f.launch, wallMinutes: 0 }) }, (worker, delivery) => Effect.gen(function* () {
      yield* startTask(delivery)
      yield* worker.drain()
      expect((yield* worker.get("run-1"))!.phase).toBe("quarantined")
      expect(spawnCount(f.launch.workingDirectory)).toBe(0)
      expect((yield* delivery.getRun("run-1"))!.status).toBe("queued")
    }))
  })

  test("ambient transaction rollback cannot launch an uncommitted goal/Run/reservation", async () => {
    const f = tracked()
    await withWorker(f.file, { adapter: f.adapter, launch: () => f.launch }, (worker, delivery) => Effect.gen(function* () {
      const { db } = yield* Database.Service
      const rolledBack = yield* db.transaction(() => Effect.gen(function* () {
        yield* startTask(delivery, "fixture exit")
        yield* worker.drain()
        return yield* Effect.fail(new Error("intended rollback"))
      }), { behavior: "immediate" }).pipe(Effect.exit)
      expect(Exit.isFailure(rolledBack)).toBe(true)
      expect(yield* delivery.getTask("task-1")).toBeUndefined()
      expect(yield* worker.get("run-1")).toBeUndefined()
      expect(spawnCount(f.launch.workingDirectory)).toBe(0)
      // Direct consume and inspect cannot bypass the same entry-point guard.
      yield* startTask(delivery, "fixture exit")
      let item: Delivery.OutboxItem | undefined
      yield* delivery.drainOutbox((next) => Effect.sync(() => { if (next.envelope.eventType === "loopit.run.started") item = next }))
      const consumed = yield* db.transaction(() => worker.consume(item!), { behavior: "immediate" }).pipe(Effect.exit)
      const inspected = yield* db.transaction(() => worker.inspect("run-1"), { behavior: "immediate" }).pipe(Effect.exit)
      expect(Exit.isFailure(consumed)).toBe(true)
      expect(Exit.isFailure(inspected)).toBe(true)
      expect(yield* worker.get("run-1")).toBeUndefined()
      expect(spawnCount(f.launch.workingDirectory)).toBe(0)
    }))
  })
})

describe("slow CLI preparation does not block accepted control intent", () => {
  for (const separateProcess of [false, true])
    test(`two four-second probes allow pause to commit before start (separate process=${separateProcess})`, async () => {
      const f = setup(), marker = join(f.root, "probe-marker")
      const slow = fixtureSource.replace('if (process.argv.includes("--version")) {', 'if (process.argv.includes("--version")) { await Bun.sleep(4000);')
        .replace('if (process.argv.includes("--help")) {', 'if (process.argv.includes("--help")) { await Bun.sleep(4000);')
      writeFileSync(f.cli.executable, slow)
      const cli = { ...f.cli, executableDigest: `sha256:${createHash("sha256").update(slow).digest("hex")}` }
      const launch = { ...f.launch, runtime: { ...f.launch.runtime, sourceDigest: cli.executableDigest } }
      writeFileSync(f.config, JSON.stringify({ file: f.file, cli, launch }))
      await withService(f.file, (delivery) => Effect.gen(function* () {
        yield* startTask(delivery, "fixture exit")
        let child: ReturnType<typeof Bun.spawn> | undefined, dispatch: Promise<unknown> | undefined
        if (separateProcess) child = Bun.spawn([process.execPath, join(import.meta.dir, "worker-child.ts"), f.config, "slow-probe", marker], { stderr: "pipe" })
        else {
          const adapter = new OpenCodeCli(cli), prepare = adapter.prepareStart.bind(adapter)
          adapter.prepareStart = (input, operationId) => { writeFileSync(marker, "before async preparation"); return prepare(input, operationId) }
          dispatch = withWorker(f.file, { adapter, launch: () => launch }, (worker) => worker.drain())
        }
        yield* Effect.promise(() => until(() => existsSync(marker)))
        const before = Date.now()
        const receipt = yield* exec(delivery, cmd.pause(2, "run-1"))
        expect(receipt.status).toBe("accepted")
        expect(Date.now() - before).toBeLessThan(2000)
        if (child) {
          const exit = yield* Effect.promise(() => child!.exited)
          expect(exit, yield* Effect.promise(() => new Response(child!.stderr as ReadableStream).text())).toBe(0)
        } else yield* Effect.promise(() => dispatch!)
        expect((yield* delivery.getRun("run-1"))!.status).toBe("pausing")
        expect(spawnCount(f.launch.workingDirectory)).toBe(0)
      }))
    }, 20_000)
})

describe("dispatch crash windows", () => {
  test("three processes consuming the same committed outbox dispatch only one real child", async () => {
    const f = setup()
    await withService(f.file, (delivery) => startTask(delivery, "fixture exit"))
    const children = Array.from({ length: 3 }, (_, index) => {
      const marker = join(f.root, `race-${index}`)
      return { marker, proc: Bun.spawn([process.execPath, join(import.meta.dir, "worker-child.ts"), f.config, "normal", marker], { stderr: "pipe" }) }
    })
    try {
      for (const child of children) {
        const exit = await child.proc.exited
        expect(exit, await new Response(child.proc.stderr).text()).toBe(0)
        expect(existsSync(child.marker)).toBe(true)
      }
      expect(spawnCount(f.launch.workingDirectory)).toBe(1)
    } finally {
      for (const child of children) if (child.proc.exitCode === null) { child.proc.kill(9); await child.proc.exited }
    }
  }, 15_000)

  for (const mode of ["crash-before-start", "crash-after-start"])
    test(`${mode}: persisted reservation survives; reopen never blindly invokes start again`, async () => {
      const f = setup(), marker = join(f.root, "crash-marker")
      await withService(f.file, (delivery) => startTask(delivery))
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "worker-child.ts"), f.config, mode, marker], { stderr: "pipe" })
      await child.exited
      expect(child.signalCode).toBe("SIGKILL")
      expect(existsSync(marker)).toBe(true)
      if (mode === "crash-after-start") {
        await until(() => existsSync(join(f.launch.workingDirectory, "fixture-pid")))
        const pid = Number(readFileSync(join(f.launch.workingDirectory, "fixture-pid"), "utf8"))
        cleanups.push(() => { try { process.kill(pid, "SIGKILL") } catch {} })
        expect(spawnCount(f.launch.workingDirectory)).toBe(1)
      }
      const reopened = new OpenCodeCli(f.cli), nativeStart = reopened.startPrepared.bind(reopened)
      let starts = 0
      reopened.startPrepared = (...args) => { starts++; return nativeStart(...args) }
      await withWorker(f.file, { adapter: reopened, launch: () => f.launch }, (worker, delivery) => Effect.gen(function* () {
        const prior = (yield* worker.get("run-1"))!
        expect(prior.phase).toBe("reserved")
        yield* worker.drain()
        const status = yield* worker.inspect("run-1")
        expect(status.kind).toBe("blocked")
        expect(status.record!.handle).toEqual(prior.handle)
        expect(starts).toBe(0)
        expect((yield* delivery.getRun("run-1"))!.status).toBe("queued")
        expect(spawnCount(f.launch.workingDirectory)).toBe(mode === "crash-after-start" ? 1 : 0)
      }))
    }, 15_000)
})
