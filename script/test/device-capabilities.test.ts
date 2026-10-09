import { afterAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { digestOf } from "../../packages/contracts/src/digest"
import { DeviceCapabilityRegistry, registryFromIosObservation, type AutonomousDeviceUse, type OperatorProbeUse, type ProbeDeviceRegistration } from "../m0/device-capabilities"
import { LocalDeviceBroker } from "../m0/local-device-broker"
import { exerciseIosBrokerProtocol } from "../m0/ios-broker-protocol"

// All positive registrations below mean operator probe only. No fixture claims
// that an OS account, simulator or independent device boundary was deployed.
const roots: string[] = []
const temp = () => { const path = mkdtempSync(join(tmpdir(), "loopit-device-admission-")); roots.push(path); return path }
afterAll(() => roots.forEach((path) => rmSync(path, { recursive: true, force: true })))
const registration: ProbeDeviceRegistration = { resourceId: "device-1", observedAt: "2026-10-09T12:00:00.000Z", osExclusiveControl: false,
  sourceRefs: [{ ref: "artifact://fixture/observation", digest: digestOf("explicit local fixture, no OS proof") }] }
const capabilities = () => new DeviceCapabilityRegistry([registration])
const probe: OperatorProbeUse = { purpose: "operator-probe-only", experimentId: "operator-experiment-1" }
const production: AutonomousDeviceUse = { purpose: "autonomous", taskId: "task-1", runId: "run-1", goalRevision: 1, goalDigest: digestOf("frozen goal") }
const deadline = () => new Date(Date.now() + 60_000).toISOString()

test("unregistered or probe-only devices refuse default and bound Task/Run admission before a lease is written", () => {
  for (const registry of [new DeviceCapabilityRegistry(), capabilities()]) {
    const broker = new LocalDeviceBroker(join(temp(), "broker.sqlite"), registry)
    try {
      const reason = registry.describe("device-1").reason
      expect(() => broker.acquire("device-1", "worker", deadline())).toThrow(reason)
      expect(() => broker.acquire("device-1", "worker", deadline(), production)).toThrow(reason)
      expect(broker.get("device-1")).toBeUndefined(); expect(broker.history("device-1")).toEqual([])
    } finally { broker.close() }
  }
})

test("explicit probe works, but it cannot become default/production dispatch or change scope midway", () => {
  const broker = new LocalDeviceBroker(join(temp(), "broker.sqlite"), capabilities())
  try {
    const token = broker.acquire("device-1", "operator", deadline(), probe)
    expect(token.admission).toMatchObject({ ...probe, capabilityDigest: capabilities().describe("device-1").capabilityDigest })
    const before = broker.history("device-1")
    expect(() => broker.begin(token, "production-default", "mutate")).toThrow("device_os_exclusivity_unproven")
    expect(() => broker.begin(token, "production-bound", "mutate", production)).toThrow("device_os_exclusivity_unproven")
    expect(() => broker.begin(token, "changed-probe", "mutate", { ...probe, experimentId: "different" })).toThrow("device_admission_scope_mismatch")
    expect(() => broker.begin(token, "mixed-purpose", "mutate", { ...probe, taskId: "task-1" } as any)).toThrow("invalid_operator_probe_scope")
    expect(broker.history("device-1")).toEqual(before)
    broker.begin(token, "operator-probe", "observe", probe)
    expect(() => broker.assertCommand(token, "operator-probe")).toThrow("device_os_exclusivity_unproven")
    expect(() => broker.assertCommand(token, "operator-probe", production)).toThrow("device_os_exclusivity_unproven")
    expect(() => broker.assertCommand(token, "operator-probe", { ...probe, experimentId: "different" })).toThrow("device_admission_scope_mismatch")
    broker.assertCommand(token, "operator-probe", probe)
    broker.finish(token, "operator-probe", "completed")
    expect(broker.get("device-1")?.inFlight).toBeUndefined()
  } finally { broker.close() }
})

test("registry digest is immutable and rechecked at the provider boundary after reopening", () => {
  const root = temp(), db = join(root, "broker.sqlite"), input = structuredClone(registration)
  const original = new DeviceCapabilityRegistry([input])
  input.sourceRefs = [{ ref: "artifact://fixture/changed", digest: digestOf("changed") }]
  const descriptor = original.describe("device-1"); descriptor.sourceRefs[0].digest = digestOf("caller changed view")
  const broker = new LocalDeviceBroker(db, original)
  const token = broker.acquire("device-1", "operator", deadline(), probe)
  broker.begin(token, "reserved-command", "mutate", probe); broker.close()
  const changed = new LocalDeviceBroker(db, new DeviceCapabilityRegistry([input]))
  try {
    expect(() => changed.assertCommand(token, "reserved-command", probe)).toThrow("device_admission_scope_mismatch")
    expect(changed.get("device-1")?.inFlight).toBe("reserved-command")
  } finally { changed.close() }
  const same = new LocalDeviceBroker(db, capabilities())
  try { same.assertCommand(token, "reserved-command", probe) } finally { same.close() }
})

test("old persisted leases without admission remain readable but cannot dispatch", () => {
  const db = join(temp(), "broker.sqlite"), broker = new LocalDeviceBroker(db, capabilities())
  const token = broker.acquire("device-1", "operator", deadline(), probe)
  broker.close()
  const sql = new Database(db)
  sql.query("UPDATE loopit_device_lease SET record=json_remove(record,'$.token.admission') WHERE resource_id=?").run("device-1")
  sql.close()
  const reopened = new LocalDeviceBroker(db, capabilities())
  try {
    const legacy = reopened.get("device-1")!.token
    expect(legacy.admission).toBeUndefined()
    expect(() => reopened.begin(legacy, "legacy-command", "mutate", probe)).toThrow("device_admission_scope_mismatch")
    expect(() => reopened.begin(token, "forged-admission", "mutate", probe)).toThrow("stale_device_fence")
  } finally { reopened.close() }
})

test("self-declared OS proof cannot create any autonomous positive registration", () => {
  expect(() => new DeviceCapabilityRegistry([{ ...registration, osExclusiveControl: true } as any])).toThrow("invalid_probe_only_device_registration")
  expect(() => new DeviceCapabilityRegistry([{ ...registration, autonomousDispatchAllowed: true } as any])).toThrow("invalid_probe_only_device_registration")
  const registry = capabilities()
  const view: any = registry.describe("device-1"); view.autonomousDispatchAllowed = true; view.osExclusiveControl = true
  expect(registry.describe("device-1")).toMatchObject({ autonomousDispatchAllowed: false, osExclusiveControl: false })
  expect(() => registry.admit("device-1", production)).toThrow("device_os_exclusivity_unproven")
  expect(() => new DeviceCapabilityRegistry().admit("device-1", probe)).toThrow("device_capability_unregistered")
})

test("finite protocol rejects a Task/Run before journal activation or any provider callback", async () => {
  const broker = new LocalDeviceBroker(join(temp(), "broker.sqlite"), capabilities())
  try {
    const token = broker.acquire("device-1", "operator", deadline(), probe)
    let journalCalls = 0, providerCalls = 0
    const provider = async () => { providerCalls++; throw new Error("must never execute") }
    await expect(exerciseIosBrokerProtocol({ broker, token, probe: production as any,
      ledger: { activate: () => { journalCalls++; return Effect.void } } as any,
      artifactDigest: digestOf("fixture"), save: () => { throw new Error("must not write") },
      install: provider, unavailableQuery: provider, query: provider, cleanup: provider })).rejects.toThrow("device_os_exclusivity_unproven")
    expect(journalCalls).toBe(0); expect(providerCalls).toBe(0)
    expect(broker.history("device-1")).toHaveLength(1)
  } finally { broker.close() }
})

test("report digest linkage registers probe-only; altered bytes and positive OS claims are rejected", () => {
  const root = temp(), resultPath = join(root, "result.json"), auditPath = join(root, "audit.json")
  const result = { schemaVersion: "ios-broker-experiment/1", status: "local-protocol-experiment-passed", target: { udid: "device-1" },
    finishedAt: registration.observedAt, osExclusiveControl: false, fullM0A08Passed: false, fullM0A10Passed: false }
  const write = (value: any, updateAudit = true) => {
    const bytes = JSON.stringify(value); writeFileSync(resultPath, bytes)
    if (updateAudit) writeFileSync(auditPath, JSON.stringify({ schemaVersion: "ios-broker-evidence-audit/1", osExclusiveControl: false, signedGate: false,
      resultDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }))
  }
  write(result)
  const observed = registryFromIosObservation(resultPath, auditPath)
  expect(observed.registry.describe("device-1")).toMatchObject({ status: "probe-only", operatorProbeAllowed: true, autonomousDispatchAllowed: false })
  write({ ...result, extra: "changed bytes" }, false)
  expect(() => registryFromIosObservation(resultPath, auditPath)).toThrow("device_observation_is_not_bound_probe_only_evidence")
  write({ ...result, osExclusiveControl: true })
  expect(() => registryFromIosObservation(resultPath, auditPath)).toThrow("device_observation_is_not_bound_probe_only_evidence")
})
