import { Database } from "@opencode-ai/core/database/database"
import { Cause, Context, Effect, Exit, Layer, Scope } from "effect"

// Connection-local: upstream OpenCode defaults to NORMAL on every open. Apply
// before delivery transactions, including when a caller injects its own service.
// FULL is a configuration requirement, not proof of real power-loss recovery.
export const ensureDeliveryDurability = (db: Pick<Database.Interface["db"], "run" | "get">) => Effect.gen(function* () {
  yield* db.run("PRAGMA synchronous = FULL")
  const mode = yield* db.get<{ synchronous: number }>("PRAGMA synchronous")
  if (mode?.synchronous !== 2) return yield* Effect.fail(new Error("Delivery requires SQLite synchronous=FULL; connection verification failed"))
})

// OpenCode v1.18.35 enables WAL before configuring busy_timeout. Concurrent
// startup/recovery can therefore fail with SQLITE_BUSY_RECOVERY before the
// normal SQLite busy handler is installed. Retry only this startup contention,
// never an execute() call, and retain the original error after the deadline.
export const databaseLayerFromPath = (filename: string, busyTimeoutMs = 5_000) =>
  Layer.effect(Database.Service, Effect.gen(function* () {
    const deadline = Date.now() + busyTimeoutMs
    while (true) {
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope, exit) => Scope.close(scope, exit))
      const opened = yield* Layer.buildWithScope(Database.layerFromPath(filename), scope).pipe(Effect.exit)
      if (Exit.isSuccess(opened)) {
        const service = Context.get(opened.value, Database.Service)
        yield* ensureDeliveryDurability(service.db)
        return service
      }
      yield* Scope.close(scope, opened)
      const error = Cause.squash(opened.cause)
      const busy = error instanceof Error && "errno" in error && typeof error.errno === "number" && (error.errno & 0xff) === 5
      const remaining = deadline - Date.now()
      if (!busy || remaining <= 0) return yield* Effect.failCause(opened.cause)
      yield* Effect.sleep(Math.min(25, remaining))
    }
  }))
