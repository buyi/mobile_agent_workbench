import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { closeSync, lstatSync, openSync } from "node:fs"
import { isAbsolute } from "node:path"
import { Id } from "../../contracts/src/common"
import { canonicalJson, digestOf } from "../../contracts/src/digest"
import type { AuthorityProof, DispatchIntent, Fence, JournalAck } from "../../delivery/src/operation-ledger"
import { decode, DispatchIntentSchema, FenceSchema, JournalError, validPin } from "./protocol"

const FORMAT = "loopit-recovery-journal/1"
const sameFence = (a: Fence, b: Fence) => a.ownerId === b.ownerId && a.epoch === b.epoch && a.generation === b.generation
const checkPath = (path: string) => {
  if (!isAbsolute(path) || path === ":memory:") throw new JournalError("absolute_database_path_required")
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new JournalError("regular_database_required")
}
function configure(db: Database) {
  db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON; PRAGMA foreign_keys=ON")
  if ((db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous !== 2)
    throw new JournalError("full_durability_unavailable")
}

/** Admin-only creation. Existing files, including another application's SQLite,
 * are never adopted or overwritten. The parent directory must already exist. */
export function initializeDatabase(path: string): { journalId: string } {
  if (!isAbsolute(path)) throw new JournalError("absolute_database_path_required")
  const fd = openSync(path, "wx", 0o600)
  closeSync(fd)
  const db = new Database(path, { create: false, readwrite: true, strict: true })
  try {
    configure(db)
    if ((db.query("PRAGMA journal_mode=WAL").get() as { journal_mode: string }).journal_mode !== "wal")
      throw new JournalError("wal_unavailable")
    const journalId = randomUUID()
    db.transaction(() => {
      db.exec(`CREATE TABLE journal_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), format TEXT NOT NULL, journal_id TEXT NOT NULL UNIQUE);
        CREATE TABLE authority (scope_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, generation INTEGER NOT NULL, epoch INTEGER NOT NULL);
        CREATE TABLE authority_history (scope_id TEXT NOT NULL, generation INTEGER NOT NULL, epoch INTEGER NOT NULL, payload_json TEXT NOT NULL,
          PRIMARY KEY(scope_id, generation, epoch));
        CREATE TABLE reservation (scope_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
          dispatch_id TEXT NOT NULL UNIQUE, request_digest TEXT NOT NULL, intent_json TEXT NOT NULL, intent_digest TEXT NOT NULL,
          PRIMARY KEY(scope_id, idempotency_key), FOREIGN KEY(scope_id) REFERENCES authority(scope_id));`)
      db.query("INSERT INTO journal_meta VALUES (1, ?, ?)").run(FORMAT, journalId)
    }).immediate()
    return { journalId }
  } finally { db.close() }
}

/** Single authoritative database protocol. A copied database retains its ID;
 * this ID detects misconfiguration, not clones, rollback or physical isolation. */
export class JournalStore {
  private readonly db: Database
  readonly journalId: string
  constructor(path: string, expectedJournalId: string) {
    decode(Id, expectedJournalId)
    checkPath(path)
    const db = new Database(path, { create: false, readwrite: true, strict: true })
    this.db = db
    try {
      configure(db)
      if ((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode !== "wal") throw new JournalError("wal_required")
      const meta = db.query("SELECT format, journal_id FROM journal_meta WHERE singleton=1").get() as { format: string; journal_id: string } | null
      if (!meta || meta.format !== FORMAT) throw new JournalError("unsupported_database_format")
      if (meta.journal_id !== expectedJournalId) throw new JournalError("journal_identity_mismatch")
      this.journalId = meta.journal_id
    } catch (error) { db.close(); throw error }
  }
  close() { this.db.close() }
  private fence(scopeId: string): Fence {
    const row = this.db.query("SELECT owner_id, generation, epoch FROM authority WHERE scope_id=?").get(scopeId) as
      { owner_id: string; generation: number; epoch: number } | null
    if (!row) throw new JournalError("scope_not_initialized")
    return decode(FenceSchema, { ownerId: row.owner_id, generation: row.generation, epoch: row.epoch })
  }
  private authorityPayload(scopeId: string, fence: Fence) { return { schemaVersion: "recovery-authority/1", journalId: this.journalId, scopeId, fence } }
  private proof(scopeId: string, fence: Fence): AuthorityProof {
    const digest = digestOf(this.authorityPayload(scopeId, fence))
    return { scopeId, fence, proof: { ref: `journal://${this.journalId}/authority/${scopeId}/${fence.generation}/${fence.epoch}#${digest}`, digest } }
  }
  private saveAuthority(scopeId: string, fence: Fence) {
    this.db.query(`INSERT INTO authority VALUES (?, ?, ?, ?) ON CONFLICT(scope_id) DO UPDATE SET
      owner_id=excluded.owner_id, generation=excluded.generation, epoch=excluded.epoch`).run(scopeId, fence.ownerId, fence.generation, fence.epoch)
    const proof = this.proof(scopeId, fence)
    this.db.query("INSERT INTO authority_history VALUES (?, ?, ?, ?)").run(scopeId, fence.generation, fence.epoch, canonicalJson(this.authorityPayload(scopeId, fence)))
    return proof
  }
  initializeScope(scopeId: string, input: Fence): AuthorityProof {
    decode(Id, scopeId)
    const fence = decode(FenceSchema, input)
    return this.db.transaction(() => {
      if (this.db.query("SELECT 1 FROM authority WHERE scope_id=?").get(scopeId)) throw new JournalError("scope_already_initialized")
      return this.saveAuthority(scopeId, fence)
    }).immediate()
  }
  advanceFence(scopeId: string, input: Fence, nextOwnerId: string): AuthorityProof {
    decode(Id, scopeId); decode(Id, nextOwnerId)
    const expected = decode(FenceSchema, input)
    return this.db.transaction(() => {
      const current = this.fence(scopeId)
      if (!sameFence(current, expected)) throw new JournalError("stale_fence")
      if (current.epoch === Number.MAX_SAFE_INTEGER || current.generation === Number.MAX_SAFE_INTEGER) throw new JournalError("fence_exhausted")
      return this.saveAuthority(scopeId, { ownerId: nextOwnerId, generation: current.generation + 1, epoch: current.epoch + 1 })
    }).immediate()
  }
  currentAuthority(scopeId: string): AuthorityProof {
    decode(Id, scopeId)
    return this.proof(scopeId, this.fence(scopeId))
  }
  reserveDispatch(input: DispatchIntent, authenticatedOwnerId: string): JournalAck {
    // The owner binding comes from the trusted invocation/transport, never the JSON body.
    decode(Id, authenticatedOwnerId)
    const intent = decode(DispatchIntentSchema, input)
    if (intent.fence.ownerId !== authenticatedOwnerId) throw new JournalError("owner_not_authorized")
    if (!validPin(intent.requestRef) || intent.requestRef.digest !== intent.requestDigest) throw new JournalError("request_digest_mismatch")
    return this.db.transaction(() => {
      if (!sameFence(this.fence(intent.scopeId), intent.fence)) throw new JournalError("stale_fence")
      const prior = this.db.query("SELECT operation_id, request_digest FROM reservation WHERE scope_id=? AND idempotency_key=?")
        .get(intent.scopeId, intent.idempotencyKey) as { operation_id: string; request_digest: string } | null
      if (prior) throw new JournalError(prior.operation_id === intent.operationId && prior.request_digest === intent.requestDigest
        ? "already_reserved" : "logical_identity_conflict")
      if (this.db.query("SELECT 1 FROM reservation WHERE operation_id=?").get(intent.operationId)) throw new JournalError("operation_id_reused")
      if (this.db.query("SELECT 1 FROM reservation WHERE dispatch_id=?").get(intent.dispatchId)) throw new JournalError("dispatch_id_reused")
      const digest = digestOf(intent)
      this.db.query("INSERT INTO reservation VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(intent.scopeId, intent.idempotencyKey, intent.operationId, intent.dispatchId, intent.requestDigest, canonicalJson(intent), digest)
      return { intent, durable: { ref: `journal://${this.journalId}/dispatch/${intent.dispatchId}#${digest}`, digest } }
      // Bun's synchronous transaction wrapper COMMITs before returning this value.
      // FULL is set and verified on this connection before any transaction begins.
    }).immediate()
  }
}
