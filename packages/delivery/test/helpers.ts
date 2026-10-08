import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { CommandReceipt } from "@loopit/contracts"
import { Delivery } from "../src"

export const tempDb = () => join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "loopit-delivery-")), "opencode.db")

/** Runs `body` against a fresh service instance on `file`, closing the database afterwards. */
export const withService = <A>(file: string, body: (service: Delivery.Interface) => Effect.Effect<A, unknown, any>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* Delivery.Service)
    }).pipe(Effect.provide(Delivery.layerFromPath(file)), Effect.scoped) as Effect.Effect<A>,
  )

export const goal = (patch: Record<string, unknown> = {}) => ({
  ...JSON.parse(readFileSync(join(import.meta.dir, "../../contracts/fixtures/valid/goal.json"), "utf8")),
  taskId: "task-1",
  ...patch,
})

let seq = 0
const base = (type: string, extra: Record<string, unknown>) => ({
  schemaVersion: "command/1",
  type,
  commandId: `cmd-${++seq}`,
  actor: { kind: "user", id: "owner" },
  issuedAt: new Date().toISOString(),
  taskId: "task-1",
  ...extra,
})

export const cmd = {
  create: (extra: Record<string, unknown> = {}) => base("createTask", { expectedVersion: 0, goal: goal(), ...extra }),
  revise: (expectedVersion: number, revision: number, extra: Record<string, unknown> = {}) =>
    base("reviseGoal", { expectedVersion, goal: goal({ goalRevision: revision, objective: `revision ${revision}` }), ...extra }),
  start: (expectedVersion: number, runId: string) => base("startRun", { expectedVersion, runId }),
  pause: (expectedVersion: number, runId: string) => base("pauseRun", { expectedVersion, runId }),
  cancel: (expectedVersion: number, runId: string) => base("cancelRun", { expectedVersion, runId }),
  resume: (expectedVersion: number, runId: string) => base("resumeRun", { expectedVersion, runId }),
  report: (runId: string, to: string, extra: Record<string, unknown> = {}) =>
    base("reportRun", { runId, to, reason: `executor reports ${to}`, actor: { kind: "worker", id: "worker-1" }, ...extra }),
}

export const usage = (usd: number | "unknown") => ({
  cost: usd === "unknown" ? { known: false, reason: "provider did not report" } : { known: true, usd },
  wallMs: 1000,
  humanInterventions: 0,
})

/** Executes and returns the receipt, failing the test on schema-invalid input. */
export const exec = (service: Delivery.Interface, input: unknown) =>
  service.execute(input).pipe(
    Effect.map((result) => {
      if (result.kind !== "receipt") throw new Error(`invalid command: ${JSON.stringify(result.issues)}`)
      return result.receipt as CommandReceipt
    }),
  )
