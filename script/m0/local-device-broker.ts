/** Local experiment protocol only. SQLite serializes calls through this broker;
 * it cannot stop another process of the same OS user calling simctl directly. */
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import { existsSync, lstatSync } from "node:fs"
import { digestOf } from "../../packages/contracts/src/digest"
import { DeviceCapabilityRegistry, type DeviceUse, type DeviceAdmission, type DeviceAdmissionAuthority } from "./device-capabilities"

export interface DeviceToken { resourceId: string; ownerId: string; leaseId: string; generation: number; epoch: number; deadlineAt: string; admission?: DeviceAdmission }
export interface DeviceLease { token: DeviceToken; status: "active" | "quarantined" | "released"; inFlight?: string; reason?: string; cleanupProof?: { ref: string; digest: string } }
const id = (value: string) => { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error("invalid_broker_identity") }

export class LocalDeviceBroker {
  private readonly db: Database
  constructor(path: string, private readonly capabilities: DeviceAdmissionAuthority = new DeviceCapabilityRegistry()) {
    if (!isAbsolute(path) || path === ":memory:" || (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())))
      throw new Error("broker_requires_regular_absolute_database")
    this.db = new Database(path, { create: true, readwrite: true, strict: true })
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON")
    if ((this.db.query("PRAGMA synchronous").get() as any).synchronous !== 2) throw new Error("broker_durability_unavailable")
    this.db.exec(`CREATE TABLE IF NOT EXISTS loopit_device_lease(resource_id TEXT PRIMARY KEY NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS loopit_device_command(operation_id TEXT PRIMARY KEY NOT NULL, resource_id TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS loopit_device_history(sequence INTEGER PRIMARY KEY AUTOINCREMENT, resource_id TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS loopit_device_history_no_update BEFORE UPDATE ON loopit_device_history BEGIN SELECT RAISE(ABORT,'device history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS loopit_device_history_no_delete BEFORE DELETE ON loopit_device_history BEGIN SELECT RAISE(ABORT,'device history is immutable'); END;`)
  }
  close() { this.db.close() }
  get(resourceId: string): DeviceLease | undefined {
    id(resourceId)
    const row = this.db.query("SELECT record FROM loopit_device_lease WHERE resource_id=?").get(resourceId) as { record: string } | null
    if (!row) return undefined
    const lease = JSON.parse(row.record) as DeviceLease
    if (!lease?.token || lease.token.resourceId !== resourceId || !["active", "quarantined", "released"].includes(lease.status) ||
        ![lease.token.generation, lease.token.epoch].every((v) => Number.isSafeInteger(v) && v > 0) ||
        !Number.isFinite(Date.parse(lease.token.deadlineAt))) throw new Error("corrupt_device_lease")
    for (const value of [lease.token.ownerId, lease.token.leaseId]) id(value)
    if (lease.inFlight !== undefined) id(lease.inFlight)
    return lease
  }
  history(resourceId: string) {
    id(resourceId)
    return (this.db.query("SELECT record FROM loopit_device_history WHERE resource_id=? ORDER BY sequence").all(resourceId) as { record: string }[])
      .map((row) => JSON.parse(row.record))
  }
  private owned(token: DeviceToken) {
    const lease = this.get(token.resourceId)
    if (!lease || digestOf(lease.token) !== digestOf(token)) throw new Error("stale_device_fence")
    return lease
  }
  /** Scope check before intent/journal side effects; not a provider permit. */
  assertAdmission(token: DeviceToken, use?: DeviceUse) {
    this.capabilities.assert(token.resourceId, token.admission, use)
    const lease = this.owned(token)
    if (lease.status !== "active") throw new Error("device_quarantined_or_released")
  }
  private save(lease: DeviceLease, event: string, detail: unknown = null) {
    this.db.query("INSERT INTO loopit_device_lease VALUES (?,?) ON CONFLICT(resource_id) DO UPDATE SET record=excluded.record")
      .run(lease.token.resourceId, JSON.stringify(lease))
    this.db.query("INSERT INTO loopit_device_history(resource_id,record) VALUES (?,?)")
      .run(lease.token.resourceId, JSON.stringify({ at: new Date().toISOString(), event, lease, detail }))
  }
  acquire(resourceId: string, ownerId: string, deadlineAt: string, use?: DeviceUse): DeviceToken {
    id(resourceId); id(ownerId)
    const admission = this.capabilities.admit(resourceId, use)
    const deadline = Date.parse(deadlineAt)
    if (!Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 15 * 60_000) throw new Error("invalid_device_lease_deadline")
    return this.db.transaction(() => {
      const prior = this.get(resourceId)
      // Expiry is never proof that the old command/owner stopped.
      if (prior && prior.status !== "released") throw new Error("device_lease_unavailable")
      const generation = (prior?.token.generation ?? 0) + 1, epoch = (prior?.token.epoch ?? 0) + 1
      if (![generation, epoch].every(Number.isSafeInteger)) throw new Error("device_fence_exhausted")
      const token = { resourceId, ownerId, leaseId: randomUUID(), generation, epoch, deadlineAt, admission }
      this.save({ token, status: "active" }, "acquired")
      return token
    }).immediate()
  }
  begin(token: DeviceToken, operationId: string, mode: "observe" | "mutate" | "cleanup", use?: DeviceUse) {
    id(operationId)
    if (!["observe", "mutate", "cleanup"].includes(mode)) throw new Error("invalid_device_command_mode")
    this.capabilities.assert(token.resourceId, token.admission, use)
    this.db.transaction(() => {
      const lease = this.owned(token)
      if (lease.status === "released" || (lease.status === "quarantined" && mode === "mutate")) throw new Error("device_quarantined_or_released")
      if (mode === "mutate" && Date.parse(token.deadlineAt) <= Date.now()) throw new Error("device_lease_expired")
      if (lease.inFlight) throw new Error("device_command_in_flight")
      if (this.db.query("SELECT 1 FROM loopit_device_command WHERE operation_id=?").get(operationId)) throw new Error("device_command_already_reserved")
      this.db.query("INSERT INTO loopit_device_command VALUES (?,?,?)").run(operationId, token.resourceId, JSON.stringify({ mode, token, state: "reserved" }))
      this.save({ ...lease, inFlight: operationId }, "command_reserved", { operationId, mode })
    }).immediate()
  }
  /** Check immediately before each provider command, including queries. */
  assertCommand(token: DeviceToken, operationId: string, use?: DeviceUse) {
    this.capabilities.assert(token.resourceId, token.admission, use)
    const lease = this.owned(token)
    if (lease.status === "released" || lease.inFlight !== operationId) throw new Error("device_command_identity_mismatch")
    const row = this.db.query("SELECT record FROM loopit_device_command WHERE operation_id=? AND resource_id=?")
      .get(operationId, token.resourceId) as { record: string } | null
    const command = row && JSON.parse(row.record)
    if (!command || command.state !== "reserved" || !["observe", "mutate", "cleanup"].includes(command.mode) || digestOf(command.token) !== digestOf(token))
      throw new Error("device_command_not_reserved")
    if (command.mode === "mutate" && (lease.status !== "active" || Date.parse(token.deadlineAt) <= Date.now()))
      throw new Error("device_mutation_not_authorized")
  }
  finish(token: DeviceToken, operationId: string, outcome: "completed" | "failed" | "unknown", evidence?: { ref: string; digest: string }) {
    id(operationId)
    if (!["completed", "failed", "unknown"].includes(outcome)) throw new Error("invalid_device_command_outcome")
    this.db.transaction(() => {
      const lease = this.owned(token)
      if (lease.inFlight !== operationId) throw new Error("device_command_identity_mismatch")
      const command = this.db.query("SELECT record FROM loopit_device_command WHERE operation_id=? AND resource_id=?")
        .get(operationId, token.resourceId) as { record: string } | null
      if (!command || JSON.parse(command.record).state !== "reserved") throw new Error("device_command_outcome_already_recorded")
      const next = { ...lease }
      if (outcome !== "unknown") delete next.inFlight
      if (outcome !== "completed") { next.status = "quarantined"; next.reason = outcome === "unknown" ? "command_outcome_unknown" : "command_failed" }
      this.db.query("UPDATE loopit_device_command SET record=json_set(record,'$.state',?,'$.evidence',json(?)) WHERE operation_id=?")
        .run(outcome, JSON.stringify(evidence ?? null), operationId)
      this.save(next, "command_finished", { operationId, outcome, evidence })
    }).immediate()
  }
  /** Query only the same unresolved command. This is not a new dispatch permit
   * and does not remove quarantine, change fence, or make the mutation retryable. */
  assertReconciliation(token: DeviceToken, operationId: string, use?: DeviceUse) {
    id(operationId)
    this.capabilities.assert(token.resourceId, token.admission, use)
    const lease = this.owned(token)
    const row = this.db.query("SELECT record FROM loopit_device_command WHERE operation_id=? AND resource_id=?")
      .get(operationId, token.resourceId) as { record: string } | null
    const command = row && JSON.parse(row.record)
    if (lease.status !== "quarantined" || lease.inFlight !== operationId || !command || command.state !== "unknown" ||
        digestOf(command.token) !== digestOf(token)) throw new Error("device_reconciliation_identity_mismatch")
  }
  /** Called only after the host verified actual observation bytes and the
   * operation ledger settled this exact operation/request/fence. Cleanup and
   * lease release remain separate trusted operations. */
  finishReconciliation(token: DeviceToken, operationId: string, outcome: "completed" | "failed", evidence: { ref: string; digest: string }, use?: DeviceUse) {
    if (!["completed", "failed"].includes(outcome) || !/^sha256:[0-9a-f]{64}$/.test(evidence.digest) ||
        !/^artifact:\/\/[^\s#]+$/.test(evidence.ref)) throw new Error("device_reconciliation_evidence_required")
    this.db.transaction(() => {
      this.assertReconciliation(token, operationId, use)
      const lease = this.owned(token), next = { ...lease, reason: "reconciled_command_requires_cleanup" }
      delete next.inFlight
      this.db.query("UPDATE loopit_device_command SET record=json_set(record,'$.state',?,'$.evidence',json(?)) WHERE operation_id=?")
        .run(outcome, JSON.stringify(evidence), operationId)
      this.save(next, "command_reconciled_by_host", { operationId, outcome, evidence })
    }).immediate()
  }
  quarantine(token: DeviceToken, reason: string) {
    id(reason)
    this.db.transaction(() => {
      const lease = this.owned(token)
      if (lease.status === "released") throw new Error("device_quarantined_or_released")
      this.save({ ...lease, status: "quarantined", reason }, "host_quarantined")
    }).immediate()
  }
  /** Trusted host must first obtain actual cleanup observations. This local
   * protocol checks only the reference pin, not an OS isolation/signature proof. */
  releaseAfterCleanup(token: DeviceToken, proof: { ref: string; digest: string }) {
    if (!/^sha256:[0-9a-f]{64}$/.test(proof.digest) || !/^artifact:\/\/[^\s#]+$/.test(proof.ref)) throw new Error("cleanup_evidence_required")
    this.db.transaction(() => {
      const lease = this.owned(token)
      if (lease.status === "released" || lease.inFlight) throw new Error("unknown_command_forbids_release")
      this.save({ ...lease, status: "released", cleanupProof: proof }, "cleanup_verified_by_host", proof)
    }).immediate()
  }
}
