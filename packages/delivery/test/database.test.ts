import { describe, expect, test } from "bun:test"
import { Database as NativeDatabase } from "bun:sqlite"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Cause, Effect, Exit, Layer } from "effect"
import { Delivery, OperationLedger } from "../src"
import { databaseLayerFromPath, ensureDeliveryDurability } from "../src/database"
import { tempDb } from "./helpers"

const open = (file: string, busyTimeoutMs: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return yield* db.get<{ ok: number }>("SELECT 1 AS ok")
    }).pipe(Effect.provide(databaseLayerFromPath(file, busyTimeoutMs)), Effect.scoped, Effect.exit),
  )

describe("database startup contention", () => {
  test("a known SQLite busy error waits for the startup lock without replaying a command", async () => {
    const file = tempDb()
    const lock = new NativeDatabase(file)
    lock.run("BEGIN EXCLUSIVE")
    const release = setTimeout(() => lock.run("ROLLBACK"), 100)
    try {
      const result = await open(file, 1_000)
      expect(Exit.isSuccess(result)).toBe(true)
      if (Exit.isSuccess(result)) expect(result.value).toEqual({ ok: 1 })
    } finally {
      clearTimeout(release)
      lock.close()
    }
  })

  test("a persistent lock fails with its SQLite error after the bounded startup window", async () => {
    const file = tempDb()
    const lock = new NativeDatabase(file)
    lock.run("BEGIN EXCLUSIVE")
    try {
      const result = await open(file, 75)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toMatchObject({ code: "SQLITE_BUSY" })
    } finally {
      lock.run("ROLLBACK")
      lock.close()
    }
  })

  test("non-contention startup errors are returned immediately, without exhausting the busy window", async () => {
    const before = Date.now()
    const result = await open(`${tempDb()}/missing/opencode.db`, 5_000)
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toMatchObject({ code: "SQLITE_CANTOPEN" })
    expect(Date.now() - before).toBeLessThan(1_000)
  })
})

describe("delivery SQLite durability configuration (not a power-loss experiment)", () => {
  test("a real connection is FULL and a newly opened scope reapplies FULL", async () => {
    const file = tempDb()
    const inspect = Effect.gen(function* () {
      const { db } = yield* Database.Service
      expect(yield* db.get("PRAGMA synchronous")).toEqual({ synchronous: 2 })
      expect(yield* db.get("PRAGMA journal_mode")).toEqual({ journal_mode: "wal" })
    })
    for (let scope = 0; scope < 2; scope++)
      await Effect.runPromise(inspect.pipe(Effect.provide(databaseLayerFromPath(file)), Effect.scoped))
  })

  for (const kind of ["delivery", "ledger"])
    test(`${kind} layerWith upgrades a supplied NORMAL connection before its transactions`, () => Effect.runPromise(Effect.gen(function* () {
      const { db } = yield* Database.Service
      expect(yield* db.get("PRAGMA synchronous")).toEqual({ synchronous: 1 })
      if (kind === "delivery")
        yield* Delivery.Service.pipe(Effect.provide(Delivery.layerWith().pipe(Layer.provideMerge(EventV2.layerWith()))))
      else yield* OperationLedger.Service.pipe(Effect.provide(OperationLedger.layerWith()))
      expect(yield* db.get("PRAGMA synchronous")).toEqual({ synchronous: 2 })
    }).pipe(Effect.provide(Database.layerFromPath(tempDb())), Effect.scoped)))

  test("durability cannot be silently weakened by initializing inside an existing transaction", () => Effect.runPromise(Effect.gen(function* () {
    const { db } = yield* Database.Service
    const result = yield* db.transaction((tx) => ensureDeliveryDurability(tx), { behavior: "immediate" }).pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    expect(yield* db.get("PRAGMA synchronous")).toEqual({ synchronous: 1 })
  }).pipe(Effect.provide(Database.layerFromPath(tempDb())), Effect.scoped)))
})
