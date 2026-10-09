import { writeFileSync } from "node:fs"
import { Cause, Effect, Exit } from "effect"
import { FakeJournal, initialFence, intent, scopeId, withLedger } from "./ledger-fixture"

const [db, mode, marker, requestedOperationId] = process.argv.slice(2)
const journal = new FakeJournal()
if (mode === "hang-journal") journal.reserveDispatch = () => Effect.sync(() => writeFileSync(marker, "waiting for independent journal")).pipe(Effect.andThen(Effect.never))
await withLedger(db, journal, (s) => Effect.gen(function* () {
  yield* s.activate(scopeId, initialFence)
  const operationId = requestedOperationId ?? "operation-1"
  const result = yield* Effect.gen(function* () {
    if (mode === "new-operation") yield* s.recordIntent(intent({ operationId }))
    return yield* s.prepareDispatch(operationId, initialFence)
  }).pipe(Effect.exit)
  const value = Exit.isSuccess(result) ? { permitted: true, permit: result.value } : { permitted: false, code: (Cause.squash(result.cause) as { code?: string }).code }
  writeFileSync(marker, JSON.stringify(value))
}))
