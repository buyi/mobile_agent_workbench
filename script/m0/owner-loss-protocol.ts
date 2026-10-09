import { Effect } from "effect"
import { createReadStream } from "node:fs"
import { digestOf } from "../../packages/contracts/src"
import type { Delivery, WorkerDispatch } from "../../packages/delivery/src"

/** Private inherited pipe, not a PID probe. A lost parent closes its endpoint;
 * blocked/missing heartbeats are also bounded. No Worker exit is fabricated. */
export function maintainChildLiveness(fd: number, timeoutMs = 2000) {
  const watchdog = setTimeout(() => process.exit(93), timeoutMs),
    pipe = createReadStream("", { fd, autoClose: false })
  pipe.on("data", () => watchdog.refresh())
  pipe.on("end", () => process.exit(94))
  pipe.on("error", () => process.exit(95))
}

/** Hold the real outbox callback open after dispatch. Killing this controller
 * leaves a genuinely unacknowledged committed event; no SQLite row is edited. */
export function holdUnacknowledgedStart(
  worker: WorkerDispatch.Interface,
  delivery: Delivery.Interface,
  runId: string,
  ready: (record: WorkerDispatch.DispatchRecord, item: Delivery.OutboxItem) => Promise<void>,
) {
  return delivery.drainOutbox((item) =>
    Effect.gen(function* () {
      yield* worker.consume(item).pipe(Effect.orDie)
      if (item.envelope.eventType !== "loopit.run.started" || (item.envelope.payload as any).runId !== runId) return
      const record = (yield* worker.get(runId))!
      if (record?.phase !== "started") throw new Error("owner_loss_child_not_started")
      yield* Effect.promise(() => ready(record, item))
      yield* Effect.never
    }),
  )
}
export function coldOwnerLossReplay(
  worker: WorkerDispatch.Interface,
  delivery: Delivery.Interface,
  expected: { record: WorkerDispatch.DispatchRecord; item: Delivery.OutboxItem },
) {
  return Effect.gen(function* () {
    const before = yield* worker.inspect(expected.record.runId)
    if (
      before.kind !== "blocked" ||
      before.record?.observed?.ownership !== "unknown" ||
      before.record.observed.status !== "running" ||
      before.record.observed.safeToRedispatch !== false
    )
      throw new Error("owner_loss_cold_ownership_not_unknown")
    const redeliveries: Array<{ eventId: string; attempt: number; kind: string; reason?: string }> = []
    yield* delivery.drainOutbox((item) =>
      Effect.gen(function* () {
        const result = yield* worker.consume(item).pipe(Effect.orDie)
        if (item.envelope.eventId !== expected.item.envelope.eventId) return
        if (
          item.id !== expected.item.id ||
          item.attempt <= expected.item.attempt ||
          result.kind !== "blocked" ||
          result.record?.observed?.ownership !== "unknown" ||
          digestOf(result.record.handle) !== digestOf(expected.record.handle)
        )
          throw new Error("owner_loss_replay_not_blocked")
        redeliveries.push({
          eventId: item.envelope.eventId,
          attempt: item.attempt,
          kind: result.kind,
          reason: result.reason,
        })
      }),
    )
    if (redeliveries.length !== 1) throw new Error("owner_loss_unacknowledged_event_not_replayed")
    const current = (yield* worker.get(expected.record.runId))!
    if (digestOf(current) !== digestOf(expected.record)) throw new Error("owner_loss_dispatch_record_changed")
    return {
      status: "blocked" as const,
      observation: before.record.observed,
      redeliveries,
      recordDigest: digestOf(current),
      run: yield* delivery.getRun(expected.record.runId),
      automaticRedispatch: false,
    }
  })
}
