import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { cmd, exec, goal, tempDb, withService } from "./helpers"

// M0-A03 / S01 / S03: kill -9 at fixed points around the transaction and dispatch,
// then reopen the same database in a fresh process and check the facts.

const child = join(import.meta.dir, "child.ts")

async function runUntilMarker(db: string, mode: string, command?: unknown) {
  const marker = `${db}.${mode}.marker`
  const proc = Bun.spawn([process.execPath, child, db, mode, marker, ...(command ? [JSON.stringify(command)] : [])], {
    stdout: "ignore",
    stderr: "pipe",
  })
  const deadline = Date.now() + 20_000
  while (!existsSync(marker)) {
    if (proc.exitCode !== null) throw new Error(`child exited early: ${await new Response(proc.stderr).text()}`)
    if (Date.now() > deadline) throw new Error(`no marker from ${mode}`)
    await Bun.sleep(20)
  }
  return { proc, marker: () => JSON.parse(readFileSync(marker, "utf8")) }
}

async function killAfterMarker(db: string, mode: string, command?: unknown) {
  const { proc, marker } = await runUntilMarker(db, mode, command)
  const value = marker()
  proc.kill(9)
  await proc.exited
  return value
}

async function seed(db: string) {
  await withService(db, (s) => exec(s, cmd.create()))
}

describe("crash recovery (M0-A03)", () => {
  test("killed inside the transaction: no event, receipt, projection or outbox survives", async () => {
    const db = tempDb()
    await seed(db)
    const start = cmd.start(1, "run-1")
    expect(await killAfterMarker(db, "hang-in-transaction", start)).toBe("in-transaction")
    await withService(db, (s) =>
      Effect.gen(function* () {
        expect((yield* s.getTask("task-1"))!.version).toBe(1)
        expect(yield* s.getRun("run-1")).toBeUndefined()
        expect(yield* s.replay("task-1")).toEqual(yield* s.getTask("task-1"))
        const delivered: string[] = []
        yield* s.drainOutbox((item) => Effect.sync(() => delivered.push(item.envelope.eventType)))
        expect(delivered).toEqual(["loopit.task.created"])
        // The client retries with the same commandId and gets exactly one intent.
        const receipt = yield* exec(s, start)
        expect(receipt.status).toBe("accepted")
        expect(receipt.aggregateVersion).toBe(2)
      }),
    )
  }, 30_000)

  test("killed after commit, before dispatch: the receipt survives and the event is delivered once", async () => {
    const db = tempDb()
    await seed(db)
    await withService(db, (s) => s.drainOutbox(() => Effect.void))
    const start = cmd.start(1, "run-1")
    const result = await killAfterMarker(db, "hang-after-commit", start)
    expect(result.receipt.status).toBe("accepted")
    await withService(db, (s) =>
      Effect.gen(function* () {
        expect(yield* exec(s, start)).toEqual(result.receipt)
        expect((yield* s.getTask("task-1"))!.version).toBe(2)
        const delivered: string[] = []
        yield* s.drainOutbox((item) => Effect.sync(() => delivered.push(item.envelope.eventId)))
        expect(delivered).toEqual([result.receipt.eventId])
      }),
    )
  }, 30_000)

  test("killed during dispatch: the same event is redelivered with the next attempt number", async () => {
    const db = tempDb()
    await seed(db)
    const inFlight = await killAfterMarker(db, "hang-in-dispatch")
    expect(inFlight.attempt).toBe(1)
    await withService(db, (s) =>
      Effect.gen(function* () {
        const delivered: Array<{ eventId: string; attempt: number }> = []
        yield* s.drainOutbox((item) => Effect.sync(() => delivered.push({ eventId: item.envelope.eventId, attempt: item.attempt })))
        expect(delivered).toEqual([{ eventId: inFlight.envelope.eventId, attempt: 2 }])
      }),
    )
  }, 30_000)
})

describe("multi-process writers", () => {
  test("S02 across processes: concurrent revisions on one version yield exactly one winner", async () => {
    const db = tempDb()
    await seed(db)
    const procs = Array.from({ length: 4 }, (_, i) => {
      const marker = `${db}.writer-${i}`
      const revise = cmd.revise(1, 2, { goal: goal({ goalRevision: 2, objective: `writer ${i}` }) })
      return { marker, proc: Bun.spawn([process.execPath, child, db, "submit", marker, JSON.stringify(revise)], { stderr: "pipe" }) }
    })
    await Promise.all(procs.map((p) => p.proc.exited))
    const receipts = procs.map((p) => JSON.parse(readFileSync(p.marker, "utf8")).receipt)
    expect(receipts.filter((r) => r.status === "accepted").length).toBe(1)
    expect(receipts.filter((r) => r.rejection?.code === "version_conflict").length).toBe(3)
    await withService(db, (s) =>
      Effect.gen(function* () {
        const task = (yield* s.getTask("task-1"))!
        expect(task.version).toBe(2)
        expect(yield* s.replay("task-1")).toEqual(task)
      }),
    )
  }, 60_000)

  test("S01 across processes: one commandId from 4 processes records one intent", async () => {
    const db = tempDb()
    await seed(db)
    const start = cmd.start(1, "run-1")
    const procs = Array.from({ length: 4 }, (_, i) => {
      const marker = `${db}.dup-${i}`
      return { marker, proc: Bun.spawn([process.execPath, child, db, "submit", marker, JSON.stringify(start)], { stderr: "pipe" }) }
    })
    await Promise.all(procs.map((p) => p.proc.exited))
    const receipts = procs.map((p) => JSON.parse(readFileSync(p.marker, "utf8")).receipt)
    for (const r of receipts) expect(r).toEqual(receipts[0])
    expect(receipts[0].status).toBe("accepted")
    await withService(db, (s) => Effect.gen(function* () {
      expect((yield* s.getTask("task-1"))!.version).toBe(2)
    }))
  }, 60_000)
})
