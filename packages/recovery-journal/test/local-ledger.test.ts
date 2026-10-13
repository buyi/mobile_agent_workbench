import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Cause, Effect, Exit } from "effect"
import { createRecoveryJournal, JournalStore } from "../src"
import { initialFence, intent, outcome, scopeId, withLedger } from "../../delivery/test/ledger-fixture"

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const cli = resolve(import.meta.dir, "../../../script/m0/recovery-journal.ts")
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "loopit-local-ledger-")); directories.push(directory)
  const databasePath = join(directory, "journal.db"), deliveryPath = join(directory, "delivery.db")
  const initialized = spawnSync(process.execPath, [cli, "init", "--db", databasePath], {
    encoding: "utf8", timeout: 10_000, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  })
  expect(initialized.status).toBe(0)
  const { journalId } = JSON.parse(initialized.stdout)
  const store = new JournalStore(databasePath, journalId)
  try { store.initializeScope(scopeId, initialFence) } finally { store.close() }
  const local = { cliPath: cli, databasePath, ownerId: initialFence.ownerId }
  return { directory, databasePath, deliveryPath, journalId, local,
    port: () => createRecoveryJournal({ journalId, local }) }
}
function reservationCount(path: string) {
  const db = new Database(path, { readonly: true })
  try { return (db.query("SELECT count(*) AS count FROM reservation").get() as { count: number }).count }
  finally { db.close() }
}
const rejected = <A>(effect: Effect.Effect<A, unknown, any>, code: string) => Effect.gen(function* () {
  const exit = yield* effect.pipe(Effect.exit)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ code })
})

describe("default local SQLite journal wired into Delivery OperationLedger", () => {
  test("a permit follows the committed reservation and cold reopening cannot grant a second one", async () => {
    const f = fixture()
    await withLedger(f.deliveryPath, f.port(), (ledger) => Effect.gen(function* () {
      yield* ledger.activate(scopeId, initialFence)
      yield* ledger.recordIntent(intent())
      const permit = yield* ledger.prepareDispatch("operation-1", initialFence)
      // A different native SQLite connection can observe the COMMIT when the
      // caller receives permission. No device or provider action is performed.
      expect(reservationCount(f.databasePath)).toBe(1)
      expect(permit.journal.intent).toEqual(permit.intent)
      expect((yield* ledger.get("operation-1"))?.phase).toBe("permitted")
    }))
    await withLedger(f.deliveryPath, f.port(), (ledger) => Effect.gen(function* () {
      yield* rejected(ledger.prepareDispatch("operation-1", initialFence), "recovery_only")
      yield* ledger.activate(scopeId, initialFence)
      yield* rejected(ledger.prepareDispatch("operation-1", initialFence), "dispatch_requires_reconciliation")
      expect(reservationCount(f.databasePath)).toBe(1)
    }))
  })

  test("a real CLI COMMIT with a lost acknowledgement remains unknown across reopen and fence advancement", async () => {
    const f = fixture(), lostAckCli = join(f.directory, "lost-ack.ts"), marker = join(f.directory, "lost-ack")
    // Fault injection wraps the real CLI. It forwards authority replies, but
    // drops the successful reserve reply after the real store has committed.
    writeFileSync(lostAckCli, `
      import { writeFileSync } from "node:fs";
      const input = await Bun.stdin.text();
      const request = JSON.parse(input);
      const result = Bun.spawnSync([process.execPath, ${JSON.stringify(cli)}, ...process.argv.slice(2)], {
        stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, timeout: 10000
      });
      if (request.method === "reserveDispatch" && result.exitCode === 0) {
        writeFileSync(${JSON.stringify(marker)}, result.stdout);
        process.exit(2);
      }
      await Bun.write(Bun.stdout, result.stdout); process.exit(result.exitCode);
    `)
    const lossy = createRecoveryJournal({ journalId: f.journalId, local: { ...f.local, cliPath: lostAckCli } })
    await withLedger(f.deliveryPath, lossy, (ledger) => Effect.gen(function* () {
      yield* ledger.activate(scopeId, initialFence)
      yield* ledger.recordIntent(intent())
      yield* rejected(ledger.prepareDispatch("operation-1", initialFence), "journal_ack_unavailable")
      expect((yield* ledger.get("operation-1"))?.phase).toBe("indeterminate")
      expect(JSON.parse(readFileSync(marker, "utf8")).ok).toBe(true)
      expect(reservationCount(f.databasePath)).toBe(1)
    }))
    await withLedger(f.deliveryPath, f.port(), (ledger) => Effect.gen(function* () {
      yield* ledger.activate(scopeId, initialFence)
      yield* rejected(ledger.prepareDispatch("operation-1", initialFence), "dispatch_requires_reconciliation")
      yield* rejected(ledger.recordIntent(intent({ operationId: "renamed-operation" })), "idempotency_key_reused")
      expect((yield* ledger.get("operation-1"))?.record.state).toBe("indeterminate")
    }))
    const store = new JournalStore(f.databasePath, f.journalId)
    let next
    try { next = store.advanceFence(scopeId, initialFence, "worker-2").fence } finally { store.close() }
    const recovered = createRecoveryJournal({ journalId: f.journalId, local: { ...f.local, ownerId: next.ownerId } })
    await withLedger(f.deliveryPath, recovered, (ledger) => Effect.gen(function* () {
      yield* rejected(ledger.activate(scopeId, initialFence), "stale_fence")
      yield* ledger.activate(scopeId, next)
      yield* rejected(ledger.prepareDispatch("operation-1", next), "stale_fence")
      expect((yield* ledger.get("operation-1"))?.phase).toBe("indeterminate")
      // Only an explicit provider observation may settle this record. This
      // fixture observation proves protocol behavior, not a real side effect.
      expect((yield* ledger.reconcile("operation-1", next, outcome)).record.state).toBe("succeeded")
      expect(reservationCount(f.databasePath)).toBe(1)
    }))
  }, 20_000)

  test("missing local storage and wrong identities fail closed without initialization or fallback", async () => {
    const f = fixture(), missing = join(f.directory, "missing.db")
    const absent = createRecoveryJournal({ journalId: f.journalId, local: { ...f.local, databasePath: missing } })
    await withLedger(f.deliveryPath, absent, (ledger) => rejected(ledger.activate(scopeId, initialFence), "authority_unavailable"))
    expect(existsSync(missing)).toBe(false)
    const wrongJournal = createRecoveryJournal({ journalId: "different-journal", local: f.local })
    await withLedger(f.deliveryPath, wrongJournal, (ledger) => rejected(ledger.activate(scopeId, initialFence), "authority_unavailable"))
    const wrongOwner = createRecoveryJournal({ journalId: f.journalId, local: { ...f.local, ownerId: "unrelated-owner" } })
    await withLedger(f.deliveryPath, wrongOwner, (ledger) => Effect.gen(function* () {
      yield* ledger.activate(scopeId, initialFence)
      yield* ledger.recordIntent(intent())
      yield* rejected(ledger.prepareDispatch("operation-1", initialFence), "journal_ack_unavailable")
      expect((yield* ledger.get("operation-1"))?.record.state).toBe("indeterminate")
    }))
    expect(reservationCount(f.databasePath)).toBe(0)
  })
})
