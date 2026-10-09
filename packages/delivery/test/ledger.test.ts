import { describe, expect, test } from "bun:test"
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { Database as NativeDatabase } from "bun:sqlite"
import { join } from "node:path"
import { Cause, Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { digestOf } from "@loopit/contracts"
import { OperationLedger as Ledger } from "../src"
import { databaseLayerFromPath } from "../src/database"
import { migrations } from "../src/sql"
import { tempDb } from "./helpers"
import { FakeJournal, initialFence, intent, outcome, scopeId, withLedger } from "./ledger-fixture"

const rejected = <A>(effect: Effect.Effect<A, unknown, any>, code: string) => Effect.gen(function* () {
  const result = yield* effect.pipe(Effect.exit)
  expect(Exit.isFailure(result)).toBe(true)
  if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toMatchObject({ code })
})
// Serialize through SQLite so the snapshot includes committed WAL pages.
// Copying only the .db file is not a valid backup of an open WAL database.
const snapshotOf = (file: string, destination: string) => {
  const connection = new NativeDatabase(file, { readonly: true })
  try { writeFileSync(destination, connection.serialize()) } finally { connection.close() }
}
const pinned = (value: Ledger.DurableRef, pin = value.digest): Ledger.DurableRef => ({ ...value, ref: `${value.ref}#${pin}` })

// Exercise upgrade from the actual old migrations, not a recreated approximation.
const legacyDatabase = (file: string) => Effect.runPromise(Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* DatabaseMigration.applyOnly(db, migrations.filter((item) => item.id !== "loopit_0003_operation_logical_identity"))
}).pipe(Effect.provide(databaseLayerFromPath(file)), Effect.scoped))
const legacyRow = (input: Ledger.IntentInput): Ledger.Entry => ({ ...input, phase: "indeterminate", history: [],
  record: { ...input.record, state: "indeterminate" } })
const insertLegacy = (db: NativeDatabase, entry: Ledger.Entry) => {
  db.query("INSERT INTO loopit_operation (operation_id, scope_id, identity_digest, entry) VALUES (?, ?, ?, ?)")
    .run(entry.record.operationId, entry.scopeId, digestOf(entry), JSON.stringify(entry))
}

describe("local operation ledger (fake journal; not independent-fault-domain evidence)", () => {
  test("without an external authority/journal no scope or dispatch can become ready", async () => {
    const db = tempDb()
    const journal = new FakeJournal()
    await withLedger(db, journal, (s) => Effect.gen(function* () {
      yield* s.activate(scopeId, initialFence)
      yield* s.recordIntent(intent())
    }))
    await withLedger(db, undefined, (s) => Effect.gen(function* () {
      yield* rejected(s.activate(scopeId, initialFence), "journal_unavailable")
      yield* rejected(s.prepareDispatch("operation-1", initialFence), "journal_unavailable")
      expect((yield* s.get("operation-1"))?.phase).toBe("intent")
    }))
  })

  test("stable intent, durable acknowledgement, one permit and idempotent receipt", () => withLedger(tempDb(), new FakeJournal(), (s) => Effect.gen(function* () {
    yield* s.activate(scopeId, initialFence)
    const first = yield* s.recordIntent(intent())
    expect(yield* s.recordIntent(intent())).toEqual(first)
    yield* rejected(s.recordIntent(intent({ requestDigest: digestOf("another candidate") })), "operation_id_reused")
    const permits = yield* Effect.all(Array.from({ length: 4 }, () => s.prepareDispatch("operation-1", initialFence).pipe(Effect.exit)), { concurrency: "unbounded" })
    expect(permits.filter(Exit.isSuccess)).toHaveLength(1)
    const entry = (yield* s.get("operation-1"))!
    expect(entry.phase).toBe("permitted")
    expect(entry.journal?.durable.digest).toBe(digestOf(entry.journal?.intent))
    const settled = yield* s.recordReceipt("operation-1", initialFence, outcome)
    expect(settled.record.state).toBe("succeeded")
    expect(yield* s.recordReceipt("operation-1", initialFence, outcome)).toEqual(settled)
    yield* rejected(s.recordReceipt("operation-1", initialFence, { ...outcome, state: "failed" }), "receipt_conflict")
    yield* rejected(s.prepareDispatch("operation-1", initialFence), "dispatch_requires_reconciliation")
  })))

  test("logical identity survives an unknown outcome and cannot be changed by renaming an operation or request", () => withLedger(tempDb(), new FakeJournal(), (s) => Effect.gen(function* () {
    yield* s.activate(scopeId, initialFence)
    yield* s.recordIntent(intent())
    yield* s.prepareDispatch("operation-1", initialFence)
    yield* s.markIndeterminate("operation-1", initialFence)
    for (const requestDigest of [intent().record.requestDigest, digestOf("different request")]) {
      yield* rejected(s.recordIntent(intent({ operationId: "operation-2", requestDigest })), "idempotency_key_reused")
      expect(yield* s.get("operation-2")).toBeUndefined()
    }
    expect((yield* s.get("operation-1"))?.record.state).toBe("indeterminate")
    // A different resource scope can legitimately use the same key, while an
    // operationId itself still has one global identity.
    const other = { ...intent({ operationId: "operation-other" }), scopeId: "release-channel-2" }
    yield* s.activate(other.scopeId, initialFence)
    yield* rejected(s.recordIntent({ ...other, record: { ...other.record, operationId: "operation-1" } }), "operation_id_reused")
    yield* s.recordIntent(other)
    expect((yield* s.prepareDispatch(other.record.operationId, initialFence)).intent.scopeId).toBe(other.scopeId)
  })))

  test("all durable-reference boundaries accept matching pins and reject contradictory pins", async () => {
    const journal = new FakeJournal()
    const current = journal.currentAuthority.bind(journal)
    journal.currentAuthority = (id) => current(id).pipe(Effect.map((proof) => ({ ...proof, proof: pinned(proof.proof, digestOf("wrong authority")) })))
    await withLedger(tempDb(), journal, (s) => rejected(s.activate(scopeId, initialFence), "stale_fence"))
    journal.currentAuthority = (id) => current(id).pipe(Effect.map((proof) => ({ ...proof, proof: pinned(proof.proof) })))
    const reserve = journal.reserveDispatch.bind(journal)
    journal.reserveDispatch = (value) => reserve(value).pipe(Effect.map((ack) => ({ ...ack, durable: pinned(ack.durable) })))
    await withLedger(tempDb(), journal, (s) => Effect.gen(function* () {
      yield* s.activate(scopeId, initialFence)
      const input = intent()
      yield* rejected(s.recordIntent({ ...input, requestRef: pinned(input.requestRef, digestOf("wrong request")) }), "invalid_intent")
      expect(yield* s.get("operation-1")).toBeUndefined()
      yield* s.recordIntent({ ...input, requestRef: pinned(input.requestRef) })
      yield* s.prepareDispatch("operation-1", initialFence)
      const bad = { ...outcome, evidence: pinned(outcome.evidence, digestOf("wrong receipt")) }
      yield* rejected(s.recordReceipt("operation-1", initialFence, bad), "evidence_required")
      expect((yield* s.get("operation-1"))?.phase).toBe("permitted")
      yield* s.markIndeterminate("operation-1", initialFence)
      yield* rejected(s.reconcile("operation-1", initialFence, bad), "evidence_required")
      expect((yield* s.reconcile("operation-1", initialFence, { ...outcome, evidence: pinned(outcome.evidence) })).record.state).toBe("succeeded")
    }))
  })

  test("a journal receipt with a contradictory URI pin leaves the operation indeterminate", () => {
    const journal = new FakeJournal(), reserve = journal.reserveDispatch.bind(journal)
    journal.reserveDispatch = (value) => reserve(value).pipe(Effect.map((ack) => ({ ...ack, durable: pinned(ack.durable, digestOf("wrong journal")) })))
    return withLedger(tempDb(), journal, (s) => Effect.gen(function* () {
      yield* s.activate(scopeId, initialFence)
      yield* s.recordIntent(intent())
      yield* rejected(s.prepareDispatch("operation-1", initialFence), "invalid_journal_ack")
      expect((yield* s.get("operation-1"))?.record.state).toBe("indeterminate")
    }))
  })

  for (const mode of ["unavailable", "invalid"] as const)
    test(`${mode} journal acknowledgement never grants a permit; operation remains indeterminate`, () => {
      const journal = new FakeJournal()
      journal.mode = mode
      return withLedger(tempDb(), journal, (s) => Effect.gen(function* () {
        yield* s.activate(scopeId, initialFence)
        yield* s.recordIntent(intent())
        yield* rejected(s.prepareDispatch("operation-1", initialFence), mode === "unavailable" ? "journal_ack_unavailable" : "invalid_journal_ack")
        expect((yield* s.get("operation-1"))?.record.state).toBe("indeterminate")
        journal.mode = "grant"
        yield* rejected(s.prepareDispatch("operation-1", initialFence), "dispatch_requires_reconciliation")
        yield* rejected(s.recordReceipt("operation-1", initialFence, outcome), "illegal_transition")
        expect((yield* s.reconcile("operation-1", initialFence, outcome)).record.state).toBe("succeeded")
      }))
    })

  test("a journal implementation defect grants no permit and leaves an indeterminate operation", () => {
    const journal = new FakeJournal()
    journal.reserveDispatch = () => { throw new Error("connector failed before returning an Effect") }
    return withLedger(tempDb(), journal, (s) => Effect.gen(function* () {
      yield* s.activate(scopeId, initialFence)
      yield* s.recordIntent(intent())
      yield* rejected(s.prepareDispatch("operation-1", initialFence), "journal_ack_unavailable")
      expect((yield* s.get("operation-1"))?.record.state).toBe("indeterminate")
    }))
  })

  test("a valid journal acknowledgement arriving after owner revocation cannot grant permission", () => {
    const journal = new FakeJournal()
    const reserve = journal.reserveDispatch.bind(journal)
    journal.reserveDispatch = (value) => reserve(value).pipe(Effect.tap(() => Effect.sync(() => {
      journal.fence = { ownerId: "worker-2", generation: 2, epoch: 2 }
    })))
    return withLedger(tempDb(), journal, (s) => Effect.gen(function* () {
      yield* s.activate(scopeId, initialFence)
      yield* s.recordIntent(intent())
      yield* rejected(s.prepareDispatch("operation-1", initialFence), "stale_fence")
      expect((yield* s.get("operation-1"))?.record.state).toBe("indeterminate")
    }))
  })

  test("recovery-only persists, a new authority fences the old owner, and only reconciliation closes unknown effects", async () => {
    const db = tempDb()
    const journal = new FakeJournal()
    await withLedger(db, journal, (s) => Effect.gen(function* () {
      yield* s.activate(scopeId, initialFence)
      yield* s.recordIntent(intent())
      yield* s.prepareDispatch("operation-1", initialFence)
      yield* s.enterRecovery(scopeId)
      yield* rejected(s.prepareDispatch("operation-1", initialFence), "recovery_only")
    }))
    journal.fence = { ownerId: "worker-2", generation: 2, epoch: 2 }
    await withLedger(db, journal, (s) => Effect.gen(function* () {
      yield* rejected(s.activate(scopeId, initialFence), "stale_fence")
      yield* s.activate(scopeId, journal.fence)
      yield* rejected(s.recordReceipt("operation-1", initialFence, outcome), "stale_fence")
      yield* rejected(s.prepareDispatch("operation-1", initialFence), "stale_fence")
      const resolved = yield* s.reconcile("operation-1", journal.fence, outcome)
      expect(resolved.ownerId).toBe("worker-2")
      expect(resolved.record.recoveryEpoch).toBe(2)
    }))
  })

  test("old SQLite snapshots cannot bypass an external journal that remembers prior dispatch", async () => {
    const db = tempDb()
    const snapshot = `${db}.backup`
    const journal = new FakeJournal()
    await withLedger(db, journal, (s) => Effect.gen(function* () {
      yield* s.activate(scopeId, initialFence)
      yield* s.recordIntent(intent())
    }))
    snapshotOf(db, snapshot)
    await withLedger(db, journal, (s) => Effect.gen(function* () {
      yield* s.activate(scopeId, initialFence)
      yield* s.prepareDispatch("operation-1", initialFence)
    }))
    const restored = tempDb()
    copyFileSync(snapshot, restored)
    journal.fence = { ...initialFence, epoch: 2, generation: 2 }
    await withLedger(restored, journal, (s) => Effect.gen(function* () {
      yield* rejected(s.prepareDispatch("operation-1", initialFence), "stale_fence")
      yield* s.activate(scopeId, journal.fence)
      // The old intent still has its old fence. It cannot be silently promoted
      // into a fresh dispatch, even though the restored SQLite lacks the permit.
      yield* rejected(s.prepareDispatch("operation-1", journal.fence), "stale_fence")
      expect(journal.reserved.size).toBe(1)
    }))
  })

  test("same fence on a restored SQLite snapshot is still rejected by external operation identity", async () => {
    const db = tempDb()
    const snapshot = `${db}.backup`
    const journal = new FakeJournal()
    await withLedger(db, journal, (s) => Effect.gen(function* () { yield* s.activate(scopeId, initialFence); yield* s.recordIntent(intent()) }))
    snapshotOf(db, snapshot)
    await withLedger(db, journal, (s) => Effect.gen(function* () { yield* s.activate(scopeId, initialFence); yield* s.prepareDispatch("operation-1", initialFence) }))
    const restored = tempDb()
    copyFileSync(snapshot, restored)
    await withLedger(restored, journal, (s) => Effect.gen(function* () {
      yield* s.activate(scopeId, initialFence)
      yield* rejected(s.prepareDispatch("operation-1", initialFence), "journal_ack_unavailable")
      expect((yield* s.get("operation-1"))?.record.state).toBe("indeterminate")
      expect(journal.reserved.size).toBe(1)
    }))
  })

  for (const changedRequest of [false, true])
    test(`a pre-intent SQLite snapshot cannot rename a remotely reserved action (changed request=${changedRequest})`, async () => {
      const db = tempDb(), snapshot = `${db}.backup`, journal = new FakeJournal()
      await withLedger(db, journal, (s) => s.activate(scopeId, initialFence))
      snapshotOf(db, snapshot)
      await withLedger(db, journal, (s) => Effect.gen(function* () {
        yield* s.activate(scopeId, initialFence)
        yield* s.recordIntent(intent())
        yield* s.prepareDispatch("operation-1", initialFence)
        yield* s.markIndeterminate("operation-1", initialFence)
      }))
      const restored = tempDb()
      copyFileSync(snapshot, restored)
      await withLedger(restored, journal, (s) => Effect.gen(function* () {
        yield* s.activate(scopeId, initialFence)
        yield* s.recordIntent(intent({ operationId: "operation-2", ...(changedRequest ? { requestDigest: digestOf("changed request") } : {}) }))
        yield* rejected(s.prepareDispatch("operation-2", initialFence), "journal_ack_unavailable")
        expect((yield* s.get("operation-2"))?.record.state).toBe("indeterminate")
        expect(journal.reserved.size).toBe(1)
      }))
    })
})

describe("operation ledger migration 0003", () => {
  test("an existing correct index without a migration marker is accepted, but a wrong index is never trusted", async () => {
    for (const correct of [true, false]) {
      const file = tempDb()
      await legacyDatabase(file)
      const native = new NativeDatabase(file)
      try {
        native.run(correct
          ? "CREATE UNIQUE INDEX loopit_operation_logical_identity_idx ON loopit_operation (scope_id, json_extract(entry, '$.record.idempotencyKey'))"
          : "CREATE INDEX loopit_operation_logical_identity_idx ON loopit_operation (scope_id)")
      } finally { native.close() }
      if (correct) await withLedger(file, new FakeJournal(), (s) => s.activate(scopeId, initialFence))
      else await expect(withLedger(file, new FakeJournal(), (s) => s.activate(scopeId, initialFence))).rejects.toThrow(/unexpected definition/)
      const checked = new NativeDatabase(file, { readonly: true })
      try {
        expect(Boolean(checked.query("SELECT id FROM migration WHERE id = 'loopit_0003_operation_logical_identity'").get())).toBe(correct)
      } finally { checked.close() }
    }
  })

  test("upgrades 0002 in place, preserves unknown records and enforces the unique identity in SQLite", async () => {
    const file = tempDb()
    await legacyDatabase(file)
    const original = legacyRow(intent()), native = new NativeDatabase(file)
    try { insertLegacy(native, original) } finally { native.close() }
    await withLedger(file, new FakeJournal(), (s) => Effect.gen(function* () {
      expect(yield* s.get("operation-1")).toEqual(original)
      yield* s.activate(scopeId, initialFence)
      yield* rejected(s.recordIntent(intent({ operationId: "operation-2" })), "idempotency_key_reused")
    }))
    const upgraded = new NativeDatabase(file)
    try {
      expect(upgraded.query("SELECT id FROM migration WHERE id = 'loopit_0003_operation_logical_identity'").get()).not.toBeNull()
      expect(() => insertLegacy(upgraded, legacyRow(intent({ operationId: "operation-2" })))).toThrow(/UNIQUE/)
      expect(upgraded.query("SELECT COUNT(*) AS count FROM loopit_operation").get()).toEqual({ count: 1 })
    } finally { upgraded.close() }
  })

  test("duplicate legacy identities block migration without deleting or rewriting either unknown action", async () => {
    const file = tempDb()
    await legacyDatabase(file)
    const originals = [legacyRow(intent()), legacyRow(intent({ operationId: "operation-2", requestDigest: digestOf("different request") }))]
    const native = new NativeDatabase(file)
    try { for (const entry of originals) insertLegacy(native, entry) } finally { native.close() }
    await expect(withLedger(file, new FakeJournal(), (s) => s.get("operation-1"))).rejects.toThrow(/UNIQUE/)
    const blocked = new NativeDatabase(file, { readonly: true })
    try {
      expect(blocked.query("SELECT entry FROM loopit_operation ORDER BY operation_id").all()).toEqual(originals.map((entry) => ({ entry: JSON.stringify(entry) })))
      expect(blocked.query("SELECT id FROM migration WHERE id = 'loopit_0003_operation_logical_identity'").get()).toBeNull()
    } finally { blocked.close() }
  })
})

const childPath = join(import.meta.dir, "ledger-child.ts")
describe("operation ledger process boundary", () => {
  test("four processes using different operation IDs compete for one logical identity", async () => {
    const db = tempDb()
    await legacyDatabase(db)
    const children = Array.from({ length: 4 }, (_, i) => {
      const marker = `${db}.identity-${i}`
      return { marker, proc: Bun.spawn([process.execPath, childPath, db, "new-operation", marker, `operation-${i}`], { stderr: "pipe" }) }
    })
    for (const child of children) expect(await child.proc.exited, await new Response(child.proc.stderr).text()).toBe(0)
    const results = children.map((child) => JSON.parse(readFileSync(child.marker, "utf8")))
    expect(results.filter((result) => result.permitted)).toHaveLength(1)
    expect(results.filter((result) => result.code === "idempotency_key_reused")).toHaveLength(3)
  }, 30_000)

  test("four processes race for one SQLite dispatch reservation; only one receives permission", async () => {
    const db = tempDb()
    await withLedger(db, new FakeJournal(), (s) => Effect.gen(function* () { yield* s.activate(scopeId, initialFence); yield* s.recordIntent(intent()) }))
    const children = Array.from({ length: 4 }, (_, i) => {
      const marker = `${db}.dispatch-${i}`
      return { marker, proc: Bun.spawn([process.execPath, childPath, db, "dispatch", marker], { stderr: "pipe" }) }
    })
    for (const child of children) expect(await child.proc.exited, await new Response(child.proc.stderr).text()).toBe(0)
    const results = children.map((child) => JSON.parse(readFileSync(child.marker, "utf8")))
    expect(results.filter((result) => result.permitted)).toHaveLength(1)
    expect(results.filter((result) => result.code === "dispatch_requires_reconciliation")).toHaveLength(3)
  }, 30_000)

  test("kill after local reservation and before journal acknowledgement blocks redispatch", async () => {
    const db = tempDb()
    const marker = `${db}.pending-journal`
    await withLedger(db, new FakeJournal(), (s) => Effect.gen(function* () { yield* s.activate(scopeId, initialFence); yield* s.recordIntent(intent()) }))
    const child = Bun.spawn([process.execPath, childPath, db, "hang-journal", marker], { stderr: "pipe" })
    const deadline = Date.now() + 10_000
    try {
      while (!existsSync(marker)) {
        if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text())
        if (Date.now() > deadline) throw new Error("journal child did not reach marker")
        await Bun.sleep(20)
      }
    } finally { child.kill(9); await child.exited }
    await withLedger(db, new FakeJournal(), (s) => Effect.gen(function* () {
      expect((yield* s.get("operation-1"))?.phase).toBe("awaiting_journal")
      yield* rejected(s.prepareDispatch("operation-1", initialFence), "recovery_only")
      yield* s.activate(scopeId, initialFence)
      yield* rejected(s.prepareDispatch("operation-1", initialFence), "dispatch_requires_reconciliation")
      yield* s.markIndeterminate("operation-1", initialFence)
      expect((yield* s.reconcile("operation-1", initialFence, outcome)).record.state).toBe("succeeded")
    }))
  }, 20_000)
})
