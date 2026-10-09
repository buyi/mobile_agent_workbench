import { afterAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { canonicalJson, digestOf } from "../../packages/contracts/src/digest"
import * as Ledger from "../../packages/delivery/src/operation-ledger"
import { initializeDatabase, JournalStore } from "../../packages/recovery-journal/src/store"
import { DeviceCapabilityRegistry, type DeviceAdmission, type DeviceAdmissionAuthority, type DeviceUse } from "../m0/device-capabilities"
import { HostDeviceBindings, bytesDigest, type DeviceBinding } from "../m0/device-binding"
import { TypedDeviceCommandPort, parseDeviceCommandRequest, type AuthorizedDeviceOperation, type DeviceCommand, type DeviceCommandRequest,
  type DeviceExecutionInstruction, type DeviceObservation, type TrustedDeviceExecutor } from "../m0/device-command-port"
import { LocalDeviceBroker } from "../m0/local-device-broker"

// Real local SQLite ledger/journal and persisted bytes, but explicit fixture
// host authority/executor. No production admission, OS identity or device proof.
const roots: string[] = []
afterAll(() => roots.forEach((path) => rmSync(path, { recursive: true, force: true })))
const binding: DeviceBinding = { schemaVersion: "device-binding/1", resourceId: "fixture-private-device", revision: 1, ownerUid: 422,
  privateSet: "/private/var/loopit/fixture-device/private-device-set", udid: "C54C75F8-3523-4F93-8A7A-7F92FA784932",
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0", deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
  bundleId: "com.seedleap.loopitapp.test", capabilityDigest: digestOf("fixture authority only, no OS proof"),
  executorId: "fixture-executor", executorDigest: digestOf("fixture executor bytes") }
const bindingDigest = digestOf(binding), goalDigest = digestOf("frozen fixture goal"), appDigest = digestOf("fixture app bytes")
const bindings = () => { const bytes = Buffer.from(canonicalJson(binding)); return new HostDeviceBindings([{ bytes, expectedDigest: bytesDigest(bytes) }]) }
const use = { purpose: "autonomous" as const, taskId: "task-1", runId: "run-1", goalRevision: 1, goalDigest }

class FixtureHostAdmission implements DeviceAdmissionAuthority {
  admit(resourceId: string, requested?: DeviceUse): DeviceAdmission {
    if (resourceId !== binding.resourceId || digestOf(requested) !== digestOf(use)) throw new Error("fixture_host_denied")
    return { ...use, bindingDigest, capabilityDigest: binding.capabilityDigest }
  }
  assert(resourceId: string, admission: DeviceAdmission | undefined, requested?: DeviceUse) {
    if (digestOf(admission) !== digestOf(this.admit(resourceId, requested))) throw new Error("fixture_admission_changed")
  }
}

function request(operationId = "operation-1", idempotencyKey = "logical-install", command: DeviceCommand = { kind: "install", artifactDigest: appDigest }): DeviceCommandRequest {
  const payload = { schemaVersion: "device-command/1" as const, operationId, idempotencyKey, taskId: use.taskId, runId: use.runId,
    goalRevision: use.goalRevision, goalDigest, resourceId: binding.resourceId, bindingDigest, command }
  return { ...payload, requestDigest: digestOf(payload) }
}
function changed(input: DeviceCommandRequest, patch: object): DeviceCommandRequest {
  const { requestDigest: _, ...payload } = { ...input, ...patch }
  return { ...payload, requestDigest: digestOf(payload) }
}

async function fixture(body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "loopit-device-command-")); roots.push(root)
  const database = join(root, "ledger.sqlite")
  await Effect.runPromise(Ledger.Service.pipe(Effect.provide(Ledger.layerFromPath(database)), Effect.scoped))
  const broker = new LocalDeviceBroker(database, new FixtureHostAdmission())
  const deadlineAt = new Date(Date.now() + 60_000).toISOString()
  const token = broker.acquire(binding.resourceId, "host-1", deadlineAt, use)
  const journalPath = join(root, "journal.sqlite"), { journalId } = initializeDatabase(journalPath), store = new JournalStore(journalPath, journalId)
  store.initializeScope(token.resourceId, { ownerId: token.ownerId, generation: token.generation, epoch: token.epoch })
  const counters = { effects: 0, queries: 0, journalReservations: 0, authorityCalls: 0 }
  const journal: Ledger.RecoveryJournal = {
    currentAuthority: (scope) => Effect.try({ try: () => { counters.authorityCalls++; return store.currentAuthority(scope) }, catch: (error) => error }),
    reserveDispatch: (intent) => Effect.try({ try: () => { counters.journalReservations++; return store.reserveDispatch(intent, token.ownerId) }, catch: (error) => error }),
  }
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const ledger = yield* Ledger.Service
      const f = yield* Effect.promise(() => setup({ root, database, broker, token, store, counters, ledger }))
      yield* Effect.promise(() => body(f))
    }).pipe(Effect.provide(Ledger.layerFromPath(database, { journal })), Effect.scoped))
  } finally { broker.close(); store.close() }
}

async function setup(input: { root: string; database: string; broker: LocalDeviceBroker; token: ReturnType<LocalDeviceBroker["acquire"]>;
  store: JournalStore; counters: { effects: number; queries: number; journalReservations: number; authorityCalls: number }; ledger: Ledger.Interface }) {
  const { root, token, counters } = input, accepted = new Map<string, AuthorizedDeviceOperation>(), files = new Map<string, string>()
  const save = (ref: string, bytes: Uint8Array): Ledger.DurableRef => {
    const previous = files.get(ref)
    if (previous) {
      if (bytesDigest(readFileSync(previous)) !== bytesDigest(bytes)) throw new Error("fixture_ref_cannot_overwrite")
      return { ref, digest: bytesDigest(bytes) }
    }
    const file = join(root, randomUUID() + ".json"), fd = openSync(file, "wx", 0o600)
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    files.set(ref, file)
    return { ref, digest: bytesDigest(bytes) }
  }
  const artifacts = {
    putRequest: (operationId: string, bytes: Uint8Array) => save(`artifact://fixture/request/${operationId}`, bytes),
    read: (ref: Ledger.DurableRef) => { const file = files.get(ref.ref); if (!file) throw new Error("fixture_artifact_missing"); return readFileSync(file) },
  }
  const authority = { current: (operationId: string) => { const value = accepted.get(operationId); return value && structuredClone(value) } }
  const accept = (r: DeviceCommandRequest) => {
    accepted.set(r.operationId, { operationId: r.operationId, idempotencyKey: r.idempotencyKey, requestDigest: r.requestDigest,
      taskId: r.taskId, runId: r.runId, goalRevision: r.goalRevision, goalDigest: r.goalDigest, resourceId: r.resourceId, bindingDigest: r.bindingDigest,
      ownerId: token.ownerId, leaseId: token.leaseId, generation: token.generation, epoch: token.epoch, deadlineAt: token.deadlineAt,
      expiresAt: token.deadlineAt, mode: "dispatch" })
    return r
  }
  const receipt = (instruction: DeviceExecutionInstruction, patch: Partial<DeviceObservation> = {}) => {
    const r = instruction.request, value: DeviceObservation = { schemaVersion: "device-observation/1", operationId: r.operationId,
      dispatchId: instruction.permit.intent.dispatchId, requestDigest: r.requestDigest, bindingDigest: r.bindingDigest, resourceId: r.resourceId,
      ownerUid: 422, udid: instruction.binding.udid, taskId: r.taskId, runId: r.runId, goalRevision: r.goalRevision, goalDigest: r.goalDigest,
      ...instruction.permit.intent.fence, outcome: "succeeded", observedAt: new Date().toISOString(), deviceState: r.command.kind === "boot" ? "Booted" : "Shutdown",
      appPresent: r.command.kind === "install", appArtifactDigest: r.command.kind === "install" ? r.command.artifactDigest : null, ...patch }
    return save(`artifact://fixture/observation/${randomUUID()}`, Buffer.from(canonicalJson(value)))
  }
  const executor: TrustedDeviceExecutor = { descriptor: { executorId: binding.executorId, executorDigest: binding.executorDigest, ownerUid: 422 },
    execute: async (instruction) => { counters.effects++; return receipt(instruction) },
    query: async (instruction) => { counters.queries++; return receipt(instruction) } }
  const host = { broker: input.broker, token, ledger: input.ledger, bindings: bindings(), authority, artifacts, executor: executor as TrustedDeviceExecutor | undefined }
  const r = accept(request()), port = new TypedDeviceCommandPort(host)
  return { ...input, accepted, save, files, artifacts, authority, accept, receipt, executor, host, request: r, port,
    reopenBroker: () => new LocalDeviceBroker(input.database, new FixtureHostAdmission()) }
}

test("host binding pins actual bytes, rejects extra command/path fields, and cannot be changed through a returned view", () => {
  const registry = bindings(), view = registry.get(binding.resourceId)
  view.binding.udid = "00000000-0000-0000-0000-000000000000"
  expect(registry.get(binding.resourceId).binding.udid).toBe(binding.udid)
  const bytes = Buffer.from(canonicalJson(binding))
  expect(() => new HostDeviceBindings([{ bytes, expectedDigest: digestOf("wrong bytes") }])).toThrow("bytes_pin_mismatch")
  for (const patch of [{ ownerUid: 420 }, { privateSet: "/private/var/loopit/../operator" }, { privateSet: "/Users/operator/default-set" }, { argv: ["/bin/sh"] }]) {
    const raw = Buffer.from(canonicalJson({ ...binding, ...patch }))
    expect(() => new HostDeviceBindings([{ bytes: raw, expectedDigest: bytesDigest(raw) }])).toThrow()
  }
  for (const patch of [{ environment: {} }, { admission: true }, { purpose: "operator-probe-only" }, { command: { kind: "install", artifactDigest: appDigest, path: "/tmp/app" } },
    { command: { kind: "spawn", argv: ["/bin/sh"] } }, { command: { kind: "boot", udid: binding.udid } }]) expect(() => parseDeviceCommandRequest(changed(request(), patch))).toThrow()
  expect(() => parseDeviceCommandRequest({ ...request(), requestDigest: digestOf("wrong") })).toThrow("request_digest_mismatch")
})

test("default/probe-only registry never becomes autonomous, and absent executor produces zero journal/provider dispatch", async () => fixture(async (f) => {
  const probeRegistry = new DeviceCapabilityRegistry([{ resourceId: binding.resourceId, observedAt: new Date().toISOString(), osExclusiveControl: false,
    sourceRefs: [{ ref: "artifact://fixture/nonproduction", digest: digestOf("fixture") }] }])
  const defaultBroker = new LocalDeviceBroker(join(f.root, "default.sqlite"), probeRegistry)
  try {
    const probeToken = defaultBroker.acquire(binding.resourceId, "operator", f.token.deadlineAt, { purpose: "operator-probe-only", experimentId: "probe" })
    const blocked = new TypedDeviceCommandPort({ ...f.host, broker: defaultBroker, token: probeToken, authority: { current: () => ({ ...f.accepted.get(f.request.operationId)!,
      ownerId: probeToken.ownerId, leaseId: probeToken.leaseId, generation: probeToken.generation, epoch: probeToken.epoch }) } })
    await expect(blocked.execute(f.request)).rejects.toThrow("device_os_exclusivity_unproven")
    expect(defaultBroker.history(binding.resourceId)).toHaveLength(1)
  } finally { defaultBroker.close() }
  await expect(new TypedDeviceCommandPort({ ...f.host, executor: undefined }).execute(f.request)).rejects.toThrow("trusted_device_executor_unavailable")
  expect(f.counters).toEqual({ effects: 0, queries: 0, journalReservations: 0, authorityCalls: 0 })
  expect(f.files.size).toBe(0)
}))

test("wrong Task/Run/Goal/op/binding or host executor pin denies before journal and device calls", async () => fixture(async (f) => {
  for (const patch of [{ taskId: "another-task" }, { runId: "another-run" }, { goalRevision: 2 }, { goalDigest: digestOf("another goal") },
    { operationId: "not-accepted" }, { resourceId: "another-device" }, { bindingDigest: digestOf("another binding") }, { command: { kind: "shutdown" } }]) {
    await expect(f.port.execute(changed(f.request, patch))).rejects.toThrow()
  }
  f.executor.descriptor.executorDigest = digestOf("changed executor")
  await expect(f.port.execute(f.request)).rejects.toThrow("executor_binding_mismatch")
  expect(f.counters.effects).toBe(0); expect(f.counters.authorityCalls).toBe(0); expect(f.files.size).toBe(0)
}))

test("one permitted fixture command uses existing SQLite/journal, and identical or renamed replay cannot dispatch twice", async () => fixture(async (f) => {
  const result = await f.port.execute(f.request)
  expect(result.outcome).toBe("succeeded")
  expect((await Effect.runPromise(f.ledger.get(f.request.operationId)))?.record.state).toBe("succeeded")
  await expect(f.port.execute(f.request)).rejects.toThrow("device_command_already_reserved")
  const renamed = f.accept(changed(f.request, { operationId: "renamed-operation" }))
  await expect(f.port.execute(renamed)).rejects.toThrow("idempotency_key_reused")
  expect(f.counters.effects).toBe(1); expect(f.counters.journalReservations).toBe(1)
}))

test("two broker connections racing the same accepted operation invoke the executor only once", async () => fixture(async (f) => {
  const other = f.reopenBroker()
  try {
    const second = new TypedDeviceCommandPort({ ...f.host, broker: other })
    const results = await Promise.allSettled([f.port.execute(f.request), second.execute(f.request)])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(f.counters.effects).toBe(1); expect(f.counters.journalReservations).toBe(1)
  } finally { other.close() }
}))

test("authorization revoked while obtaining the journal permit is rechecked before any executor call", async () => fixture(async (f) => {
  const port = new TypedDeviceCommandPort({ ...f.host, ledger: { ...f.ledger,
    prepareDispatch: (id, fence) => f.ledger.prepareDispatch(id, fence).pipe(Effect.tap(() => Effect.sync(() => { f.accepted.get(id)!.mode = "reconcile-only" }))) } })
  await expect(port.execute(f.request)).rejects.toThrow("device_operation_not_authorized")
  expect(f.counters.effects).toBe(0); expect(f.counters.journalReservations).toBe(1)
  expect((await Effect.runPromise(f.ledger.get(f.request.operationId)))?.record.state).toBe("indeterminate")
  expect(f.broker.get(binding.resourceId)?.status).toBe("quarantined")
}))

test("lost receipt persists unknown across broker reopen; unavailable query never executes again; bound query settles but keeps quarantine", async () => fixture(async (f) => {
  f.executor.execute = async () => { f.counters.effects++; throw new Error("fixture_receipt_lost_after_effect") }
  await expect(f.port.execute(f.request)).rejects.toThrow("receipt_lost_after_effect")
  const other = f.reopenBroker(), port = new TypedDeviceCommandPort({ ...f.host, broker: other })
  try {
    f.accepted.get(f.request.operationId)!.mode = "reconcile-only"
    await expect(port.execute(f.request)).rejects.toThrow()
    f.executor.query = async () => { f.counters.queries++; throw new Error("fixture_query_unavailable") }
    await expect(port.query(f.request)).rejects.toThrow("query_unavailable")
    expect((await Effect.runPromise(f.ledger.get(f.request.operationId)))?.record.state).toBe("indeterminate")
    expect(other.get(binding.resourceId)?.inFlight).toBe(f.request.operationId)
    f.executor.query = async (instruction) => { f.counters.queries++; return f.receipt(instruction) }
    const result = await port.query(f.request)
    expect(result.resourceRemainsQuarantined).toBe(true)
    expect(other.get(binding.resourceId)).toMatchObject({ status: "quarantined", reason: "reconciled_command_requires_cleanup" })
    expect(other.get(binding.resourceId)?.inFlight).toBeUndefined()
    expect((await Effect.runPromise(f.ledger.get(f.request.operationId)))?.record.state).toBe("succeeded")
    await expect(port.query(f.request)).rejects.toThrow("reconciliation_identity_mismatch")
    expect(f.counters.effects).toBe(1); expect(f.counters.queries).toBe(2); expect(f.counters.journalReservations).toBe(1)
  } finally { other.close() }
}))

test("unknown operation cannot be queried under changed request or a journal's later epoch", async () => fixture(async (f) => {
  f.executor.execute = async () => { f.counters.effects++; throw new Error("lost") }
  await expect(f.port.execute(f.request)).rejects.toThrow("lost")
  await expect(f.port.query(changed(f.request, { runId: "later-run" }))).rejects.toThrow("operation_not_authorized")
  f.store.advanceFence(binding.resourceId, { ownerId: f.token.ownerId, generation: f.token.generation, epoch: f.token.epoch }, "later-owner")
  await expect(f.port.query(f.request)).rejects.toThrow("stale_fence")
  expect(f.counters.effects).toBe(1); expect(f.counters.queries).toBe(0)
  expect(f.broker.get(binding.resourceId)?.inFlight).toBe(f.request.operationId)
}))

test.each(["wrong-run", "wrong-operation", "wrong-artifact", "tampered-bytes"])("%s observation cannot settle an operation", async (mode) => fixture(async (f) => {
  f.executor.execute = async (instruction) => {
    f.counters.effects++
    const evidence = f.receipt(instruction, mode === "wrong-run" ? { runId: "other-run" } : mode === "wrong-operation" ? { operationId: "other-operation" } :
      mode === "wrong-artifact" ? { appArtifactDigest: digestOf("unapproved app") } : {})
    if (mode === "tampered-bytes") writeFileSync(f.files.get(evidence.ref)!, "changed real file bytes")
    return evidence
  }
  await expect(f.port.execute(f.request)).rejects.toThrow()
  expect((await Effect.runPromise(f.ledger.get(f.request.operationId)))?.record.state).toBe("indeterminate")
  expect(f.broker.get(binding.resourceId)?.inFlight).toBe(f.request.operationId)
  expect(f.counters.effects).toBe(1)
}))
