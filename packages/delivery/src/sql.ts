import { sql } from "drizzle-orm"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Effect } from "effect"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"

// Loopit delivery tables live in OpenCode's database (ADR-0002). Events themselves
// are OpenCode `event` rows; these tables are projections, receipts and the outbox.

export const TaskTable = sqliteTable("loopit_task", {
  task_id: text().primaryKey(),
  project_id: text().notNull(),
  version: integer().notNull(),
  current_revision: integer().notNull(),
  status: text().notNull(),
  state: text({ mode: "json" }).notNull(),
  updated_at: text().notNull(),
})

export const RunTable = sqliteTable(
  "loopit_run",
  {
    run_id: text().primaryKey(),
    task_id: text().notNull(),
    goal_revision: integer().notNull(),
    status: text().notNull(),
    updated_at: text().notNull(),
  },
  (table) => [index("loopit_run_task_idx").on(table.task_id)],
)

export const ReceiptTable = sqliteTable("loopit_command_receipt", {
  command_id: text().primaryKey(),
  task_id: text().notNull(),
  request_digest: text().notNull(),
  status: text().notNull(),
  receipt: text({ mode: "json" }).notNull(),
})

export const OutboxTable = sqliteTable("loopit_outbox", {
  id: integer().primaryKey({ autoIncrement: true }),
  event_id: text().notNull().unique(),
  task_id: text().notNull(),
  envelope: text({ mode: "json" }).notNull(),
  attempts: integer().notNull().default(0),
  dispatched_at: text(),
})

export const OperationTable = sqliteTable("loopit_operation", {
  operation_id: text().primaryKey(),
  scope_id: text().notNull(),
  identity_digest: text().notNull(),
  entry: text({ mode: "json" }).notNull(),
}, (table) => [uniqueIndex("loopit_operation_logical_identity_idx").on(table.scope_id, sql`json_extract(${table.entry}, '$.record.idempotencyKey')`)])

export const AuthorityTable = sqliteTable("loopit_operation_authority", {
  scope_id: text().primaryKey(),
  authority: text({ mode: "json" }).notNull(),
})

export const migrations: DatabaseMigration.Migration[] = [
  {
    id: "loopit_0001_delivery_core",
    up: (tx) =>
      Effect.gen(function* () {
        yield* tx.run(sql`CREATE TABLE loopit_task (
          task_id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          current_revision INTEGER NOT NULL,
          status TEXT NOT NULL,
          state TEXT NOT NULL,
          updated_at TEXT NOT NULL)`)
        yield* tx.run(sql`CREATE TABLE loopit_run (
          run_id TEXT PRIMARY KEY NOT NULL,
          task_id TEXT NOT NULL,
          goal_revision INTEGER NOT NULL,
          status TEXT NOT NULL,
          updated_at TEXT NOT NULL)`)
        yield* tx.run(sql`CREATE INDEX loopit_run_task_idx ON loopit_run (task_id)`)
        yield* tx.run(sql`CREATE TABLE loopit_command_receipt (
          command_id TEXT PRIMARY KEY NOT NULL,
          task_id TEXT NOT NULL,
          request_digest TEXT NOT NULL,
          status TEXT NOT NULL,
          receipt TEXT NOT NULL)`)
        yield* tx.run(sql`CREATE TABLE loopit_outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          event_id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL,
          envelope TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          dispatched_at TEXT)`)
      }),
  },
  {
    id: "loopit_0002_operation_ledger",
    up: (tx) => Effect.gen(function* () {
      yield* tx.run(sql`CREATE TABLE loopit_operation (
        operation_id TEXT PRIMARY KEY NOT NULL,
        scope_id TEXT NOT NULL,
        identity_digest TEXT NOT NULL,
        entry TEXT NOT NULL)`)
      yield* tx.run(sql`CREATE INDEX loopit_operation_scope_idx ON loopit_operation (scope_id)`)
      yield* tx.run(sql`CREATE TABLE loopit_operation_authority (
        scope_id TEXT PRIMARY KEY NOT NULL,
        authority TEXT NOT NULL)`)
    }),
  },
  {
    id: "loopit_0003_operation_logical_identity",
    up: (tx) => Effect.gen(function* () {
      // Existing 0002 rows remain untouched. Conflicting legacy identities fail
      // this migration closed; unknown effects must be reconciled, never merged.
      yield* tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS loopit_operation_logical_identity_idx
        ON loopit_operation (scope_id, json_extract(entry, '$.record.idempotencyKey'))`)
      const index = yield* tx.get<{ sql: string }>(sql`SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = 'loopit_operation_logical_identity_idx' AND tbl_name = 'loopit_operation'`)
      const expected = "CREATE UNIQUE INDEX loopit_operation_logical_identity_idx ON loopit_operation (scope_id, json_extract(entry, '$.record.idempotencyKey'))"
      if (index?.sql.replace(/\s+/g, " ").replace("INDEX IF NOT EXISTS ", "INDEX ").trim() !== expected)
        return yield* Effect.fail(new Error("Existing operation logical-identity index has an unexpected definition; migration refused"))
    }),
  },
]

// Upstream applyOnly reads completed migrations before its per-migration
// transactions. Serialize that read with the DDL and migration marker across
// processes; retrying a failed DDL could hide a partially applied migration.
export const applyMigrations = (db: Parameters<typeof DatabaseMigration.applyOnly>[0]) =>
  db.transaction((tx) => DatabaseMigration.applyOnly(tx, migrations), { behavior: "immediate" })
