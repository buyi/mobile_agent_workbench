// Out-of-process actor for crash and multi-writer tests. Usage:
//   bun child.ts <db> <mode> <marker> [command-json]
// Modes: submit | hang-in-transaction | hang-after-commit | hang-in-dispatch
import { writeFileSync } from "node:fs"
import { Effect } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { Delivery, DeliveryEvents } from "../src"

const [db, mode, marker, json] = process.argv.slice(2)
const mark = (value: unknown) => Effect.sync(() => writeFileSync(marker, JSON.stringify(value)))

const program = Effect.gen(function* () {
  const service = yield* Delivery.Service
  const command = json ? JSON.parse(json) : undefined
  switch (mode) {
    case "submit": {
      const result = yield* service.execute(command)
      return yield* mark(result)
    }
    case "hang-in-transaction": {
      const events = yield* EventV2.Service
      // Runs inside the event transaction, after the projection was written.
      for (const definition of DeliveryEvents.definitions)
        yield* events.project(definition, () => mark("in-transaction").pipe(Effect.andThen(Effect.never)))
      return yield* service.execute(command)
    }
    case "hang-after-commit": {
      const result = yield* service.execute(command)
      yield* mark(result)
      return yield* Effect.never
    }
    case "hang-in-dispatch":
      return yield* service.drainOutbox((item) => mark(item).pipe(Effect.andThen(Effect.never)))
  }
  throw new Error(`unknown mode ${mode}`)
})

await Effect.runPromise(program.pipe(Effect.provide(Delivery.layerFromPath(db)), Effect.scoped) as Effect.Effect<unknown>)
