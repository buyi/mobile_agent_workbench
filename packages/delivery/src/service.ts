import { asc, eq, isNull } from "drizzle-orm"
import { Cause, Context, Effect, Exit, Layer, Option, Stream } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { EventV2 } from "@opencode-ai/core/event"
import {
  type Command,
  type CommandReceipt,
  type ContractIssue,
  digestOf,
  type EventEnvelope,
  parse,
  type RunStatus,
  type TaskStatus,
} from "@loopit/contracts"
import { definitions, type DeliveryEvent, manifest } from "./events"
import { decide, evolve, type RunState, type TaskState, taskStatus } from "./model"
import { migrations, OutboxTable, ReceiptTable, RunTable, TaskTable } from "./sql"

export type ExecuteResult =
  | { readonly kind: "receipt"; readonly receipt: CommandReceipt }
  | { readonly kind: "invalid"; readonly issues: ReadonlyArray<ContractIssue> }

export type ReadResult =
  | { readonly mode: "delta"; readonly events: EventEnvelope[]; readonly cursor: number; readonly hasMore: boolean }
  | { readonly mode: "snapshot"; readonly task: TaskState; readonly cursor: number }

export interface OutboxItem {
  readonly id: number
  readonly attempt: number
  readonly envelope: EventEnvelope
}

export interface Interface {
  /** createTask/reviseGoal/startRun/pauseRun/cancelRun/resumeRun/reportRun. */
  readonly execute: (input: unknown) => Effect.Effect<ExecuteResult>
  readonly getTask: (taskId: string) => Effect.Effect<TaskState | undefined>
  readonly getRun: (runId: string) => Effect.Effect<(RunState & { readonly taskId: string }) | undefined>
  /** Events after `cursor` (an aggregateVersion); a missing or unusable cursor yields a snapshot. */
  readonly readEvents: (taskId: string, cursor?: number, limit?: number) => Effect.Effect<ReadResult>
  /** Committed events after `cursor`, then live ones; fails on overflow so the client reconnects by cursor. */
  readonly watch: (taskId: string, cursor: number) => Stream.Stream<EventEnvelope, EventV2.SubscriberOverflowError>
  /** At-least-once delivery of committed events; consumers dedupe by eventId. */
  readonly drainOutbox: (handler: (item: OutboxItem) => Effect.Effect<void>, limit?: number) => Effect.Effect<number>
  /** Recomputes state from the event log alone (projection consistency checks). */
  readonly replay: (taskId: string) => Effect.Effect<TaskState | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@loopit/delivery/Delivery") {}

export interface Options {
  readonly now?: () => string
  readonly watchCapacity?: number
}

class VersionRace extends Error {}

const PAGE = 500

export const layerWith = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const now = options.now ?? (() => new Date().toISOString())
      yield* DatabaseMigration.applyOnly(db, migrations).pipe(Effect.orDie)

      const loadState = (taskId: string) =>
        db
          .select({ state: TaskTable.state })
          .from(TaskTable)
          .where(eq(TaskTable.task_id, taskId))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => row?.state as TaskState | undefined),
          )

      const loadReceipt = (commandId: string) =>
        db
          .select()
          .from(ReceiptTable)
          .where(eq(ReceiptTable.command_id, commandId))
          .get()
          .pipe(Effect.orDie)

      const toEnvelope = (event: DeliveryEvent, recordedAt: string): EventEnvelope => ({
        schemaVersion: "event/1",
        eventId: event.id,
        aggregateId: event.data.taskId,
        aggregateVersion: event.durable!.seq + 1,
        eventType: event.type,
        eventSchemaVersion: event.durable!.version,
        commandId: event.data.commandId,
        causationId: event.data.causationId,
        correlationId: event.data.correlationId,
        occurredAt: event.data.occurredAt,
        recordedAt,
        actor: event.data.actor,
        payload: event.data,
      })

      // Projection: runs inside the event transaction, so it commits or rolls back with it.
      for (const definition of definitions)
        yield* events.project(definition, (event) =>
          Effect.gen(function* () {
            const payload = event as DeliveryEvent
            const state = evolve(yield* loadState(payload.data.taskId), payload)
            const at = payload.data.occurredAt
            yield* db
              .insert(TaskTable)
              .values({
                task_id: state.taskId,
                project_id: state.projectId,
                version: state.version,
                current_revision: state.currentRevision,
                status: taskStatus(state),
                state,
                updated_at: at,
              })
              .onConflictDoUpdate({
                target: TaskTable.task_id,
                set: { version: state.version, current_revision: state.currentRevision, status: taskStatus(state), state, updated_at: at },
              })
              .run()
              .pipe(Effect.orDie)
            const runId = "runId" in payload.data ? payload.data.runId : undefined
            const stopped = "stopRun" in payload.data ? payload.data.stopRun?.runId : undefined
            for (const id of [runId, stopped]) {
              if (!id) continue
              const run = state.runs[id]
              yield* db
                .insert(RunTable)
                .values({ run_id: id, task_id: state.taskId, goal_revision: run.goalRevision, status: run.status, updated_at: at })
                .onConflictDoUpdate({ target: RunTable.run_id, set: { status: run.status, updated_at: at } })
                .run()
                .pipe(Effect.orDie)
            }
          }),
        )

      const storeRejection = (command: Command, requestDigest: string, version: number, code: string, message: string) =>
        Effect.gen(function* () {
          const receipt: CommandReceipt = {
            schemaVersion: "receipt/1",
            commandId: command.commandId,
            commandType: command.type,
            requestDigest,
            status: "rejected",
            aggregateId: command.taskId,
            aggregateVersion: version,
            rejection: { code, message },
            recordedAt: now(),
          }
          yield* db
            .insert(ReceiptTable)
            .values({ command_id: command.commandId, task_id: command.taskId, request_digest: requestDigest, status: "rejected", receipt })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          // A concurrent attempt may have stored first; the stored receipt is authoritative.
          return (yield* loadReceipt(command.commandId))!
        })

      const attempt = (command: Command, requestDigest: string) =>
        Effect.gen(function* () {
          const stored = yield* loadReceipt(command.commandId)
          if (stored) return stored
          const state = yield* loadState(command.taskId)
          const version = state?.version ?? 0
          const decision = decide(state, command, now())
          if (!decision.ok) return yield* storeRejection(command, requestDigest, version, decision.code, decision.message)
          const eventId = EventV2.ID.create()

          const exit = yield* events
            .publish(decision.definition, decision.data as never, {
              commit: (seq) =>
                Effect.gen(function* () {
                  // The decision was taken against `version`; any other seq means a concurrent writer won.
                  if (seq !== version) return yield* Effect.die(new VersionRace())
                  const recordedAt = now()
                  const event = { id: eventId, type: decision.definition.type, data: decision.data, durable: { aggregateID: command.taskId, seq, version: 1 } } as DeliveryEvent
                  const receipt: CommandReceipt = {
                    schemaVersion: "receipt/1",
                    commandId: command.commandId,
                    commandType: command.type,
                    requestDigest,
                    status: "accepted",
                    aggregateId: command.taskId,
                    aggregateVersion: seq + 1,
                    eventId,
                    recordedAt,
                  }
                  yield* db
                    .insert(ReceiptTable)
                    .values({ command_id: command.commandId, task_id: command.taskId, request_digest: requestDigest, status: "accepted", receipt })
                    .run()
                    .pipe(Effect.orDie)
                  yield* db
                    .insert(OutboxTable)
                    .values({ event_id: eventId, task_id: command.taskId, envelope: toEnvelope(event, recordedAt) })
                    .run()
                    .pipe(Effect.orDie)
                }),
              id: eventId,
            })
            .pipe(Effect.exit)
          if (Exit.isSuccess(exit)) return (yield* loadReceipt(command.commandId))!
          // Duplicate commandId raced us, or another writer advanced the aggregate: re-run the whole step.
          if (yield* loadReceipt(command.commandId)) return (yield* loadReceipt(command.commandId))!
          if (Cause.squash(exit.cause) instanceof VersionRace) return undefined
          return yield* Effect.failCause(exit.cause as Cause.Cause<never>)
        }).pipe(Effect.orDie)

      const execute = (input: unknown) =>
        Effect.gen(function* () {
          const parsed = parse("command", input)
          if (!parsed.ok) return { kind: "invalid", issues: parsed.issues } as ExecuteResult
          const command = parsed.value
          const { issuedAt: _, ...request } = command
          const requestDigest = digestOf(request)
          for (let round = 0; round < 8; round++) {
            const row = yield* attempt(command, requestDigest)
            if (!row) continue
            if (row.request_digest !== requestDigest)
              return {
                kind: "receipt",
                receipt: {
                  schemaVersion: "receipt/1",
                  commandId: command.commandId,
                  commandType: command.type,
                  requestDigest,
                  status: "rejected",
                  aggregateId: command.taskId,
                  aggregateVersion: (row.receipt as CommandReceipt).aggregateVersion,
                  rejection: { code: "command_id_reused", message: "commandId was already used for a different request" },
                  recordedAt: now(),
                },
              } as ExecuteResult
            return { kind: "receipt", receipt: row.receipt as CommandReceipt } as ExecuteResult
          }
          return yield* Effect.die(new Error(`Command ${command.commandId} lost 8 consecutive version races`))
        })

      const readDelta = (taskId: string, cursor: number, limit: number) =>
        EventV2.readAggregate(db, { aggregateID: taskId, after: cursor - 1, limit, manifest }).pipe(
          Effect.map(({ events: page, hasMore }) => {
            const envelopes = (page as DeliveryEvent[]).map((event) => toEnvelope(event, event.data.occurredAt))
            return { events: envelopes, cursor: envelopes.at(-1)?.aggregateVersion ?? cursor, hasMore }
          }),
        )

      const readEvents = (taskId: string, cursor?: number, limit = PAGE) =>
        Effect.gen(function* () {
          const state = yield* loadState(taskId)
          const version = state?.version ?? 0
          if (cursor === undefined || cursor < 0 || cursor > version) {
            if (!state) return { mode: "delta", events: [], cursor: 0, hasMore: false } as ReadResult
            return { mode: "snapshot", task: state, cursor: version } as ReadResult
          }
          return { mode: "delta", ...(yield* readDelta(taskId, cursor, limit)) } as ReadResult
        })

      const watch = (taskId: string, cursor: number) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribe before reading history so nothing committed in between is missed.
            const live = yield* EventV2.allBounded(events, options.watchCapacity ?? 1024)
            let last = cursor
            const catchUp = Stream.paginate<number, EventEnvelope>(cursor, (after) =>
              readDelta(taskId, after, PAGE).pipe(
                Effect.map((page) => [page.events, page.hasMore ? Option.some(page.cursor) : Option.none<number>()] as const),
              ),
            )
            const fresh = live.pipe(
              Stream.filter((event) => event.type.startsWith("loopit.") && (event.data as { taskId?: string }).taskId === taskId),
              Stream.map((event) => toEnvelope(event as DeliveryEvent, now())),
            )
            return Stream.concat(catchUp, fresh).pipe(
              Stream.filter((envelope) => {
                if (envelope.aggregateVersion <= last) return false
                last = envelope.aggregateVersion
                return true
              }),
            )
          }),
        )

      const drainOutbox = (handler: (item: OutboxItem) => Effect.Effect<void>, limit = 100) =>
        Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(OutboxTable)
            .where(isNull(OutboxTable.dispatched_at))
            .orderBy(asc(OutboxTable.id))
            .limit(limit)
            .all()
            .pipe(Effect.orDie)
          for (const row of rows) {
            // Count the attempt before handing it out: a crash mid-dispatch is visible as a redelivery.
            yield* db.update(OutboxTable).set({ attempts: row.attempts + 1 }).where(eq(OutboxTable.id, row.id)).run().pipe(Effect.orDie)
            yield* handler({ id: row.id, attempt: row.attempts + 1, envelope: row.envelope as EventEnvelope })
            yield* db.update(OutboxTable).set({ dispatched_at: now() }).where(eq(OutboxTable.id, row.id)).run().pipe(Effect.orDie)
          }
          return rows.length
        })

      const replay = (taskId: string) =>
        Effect.gen(function* () {
          let state: TaskState | undefined
          let after = -1
          while (true) {
            const page = yield* EventV2.readAggregate(db, { aggregateID: taskId, after, limit: PAGE, manifest })
            for (const event of page.events as DeliveryEvent[]) state = evolve(state, event)
            after = (page.events.at(-1) as DeliveryEvent | undefined)?.durable?.seq ?? after
            if (!page.hasMore) return state
          }
        })

      const getRun = (runId: string) =>
        Effect.gen(function* () {
          const row = yield* db.select().from(RunTable).where(eq(RunTable.run_id, runId)).get().pipe(Effect.orDie)
          if (!row) return undefined
          const state = yield* loadState(row.task_id)
          return state ? { ...state.runs[runId], taskId: row.task_id } : undefined
        })

      return Service.of({ execute, getTask: loadState, getRun, readEvents, watch, drainOutbox, replay })
    }),
  )

export const layer = layerWith()

/** Delivery service on an OpenCode database file, with its own EventV2 instance. */
export const layerFromPath = (filename: string, options?: Options) =>
  layerWith(options).pipe(Layer.provideMerge(EventV2.layerWith()), Layer.provideMerge(Database.layerFromPath(filename)))

export type { RunStatus, TaskStatus }
