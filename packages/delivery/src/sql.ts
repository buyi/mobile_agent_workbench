import { sql } from "drizzle-orm"
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Effect } from "effect"
import type { DatabaseMigration } from "@opencode-ai/core/database/migration"

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
]
