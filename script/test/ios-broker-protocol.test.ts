import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { digestOf } from "../../packages/contracts/src/digest"
import * as Ledger from "../../packages/delivery/src/operation-ledger"
import { initializeDatabase, JournalStore } from "../../packages/recovery-journal/src/store"
import { createRecoveryJournal, localStdioTransport } from "../../packages/recovery-journal/src/port"
import { LocalDeviceBroker } from "../m0/local-device-broker"
import { DeviceCapabilityRegistry, type OperatorProbeUse } from "../m0/device-capabilities"
import { exerciseIosBrokerProtocol } from "../m0/ios-broker-protocol"
import { TARGET, validateExperimentPlan } from "../m0/ios-broker-experiment"

// No simctl, device, model or administrator calls. Both stores are real SQLite,
// but these fixture ports are not evidence of OS isolation or independent hosts.
const directories: string[] = []
function temp() { const path = mkdtempSync(join(tmpdir(), "loopit-device-protocol-")); directories.push(path); return path }
afterAll(() => { for (const path of directories) rmSync(path, { recursive: true, force: true }) })
const deadline = () => new Date(Date.now() + 60_000).toISOString()
const proof = { ref: "artifact://fixture/cleanup", digest: digestOf("fixture cleanup") }
const probe: OperatorProbeUse = { purpose: "operator-probe-only", experimentId: "fixture-probe" }
const registration = { resourceId: "device-1", observedAt: "2026-10-09T10:00:00.000Z", osExclusiveControl: false as const, sourceRefs: [proof] }
const fixtureCapabilities = () => new DeviceCapabilityRegistry([registration])

describe("local device broker protocol, not OS exclusivity", () => {
  test("four real processes get exactly one lease; reopen preserves owner and audit", async () => {
    const root = temp(), db = join(root, "device.sqlite"), child = join(root, "acquire.ts")
    new LocalDeviceBroker(db, fixtureCapabilities()).close()
    writeFileSync(child, `import { LocalDeviceBroker } from ${JSON.stringify(resolve("script/m0/local-device-broker.ts"))};
      import { DeviceCapabilityRegistry } from ${JSON.stringify(resolve("script/m0/device-capabilities.ts"))};
      const probe = ${JSON.stringify(probe)};
      const b = new LocalDeviceBroker(process.argv[2], new DeviceCapabilityRegistry([${JSON.stringify(registration)}]));
      try { console.log(JSON.stringify({ accepted:true,token:b.acquire("device-1",process.argv[3],process.argv[4],probe) })); }
      catch(e) { console.log(JSON.stringify({accepted:false,error:e.message})); } finally { b.close(); }`)
    const results = await Promise.all(Array.from({ length: 4 }, async (_, i) => {
      const childProcess = Bun.spawn([process.execPath, child, db, `owner-${i}`, deadline()], { stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, code] = await Promise.all([new Response(childProcess.stdout).text(), new Response(childProcess.stderr).text(), childProcess.exited])
      expect({ stderr, code }).toEqual({ stderr: "", code: 0 })
      return JSON.parse(stdout)
    }))
    expect(results.filter((r) => r.accepted)).toHaveLength(1)
    expect(results.filter((r) => !r.accepted).every((r) => r.error === "device_lease_unavailable")).toBe(true)
    const reopened = new LocalDeviceBroker(db, fixtureCapabilities())
    expect(reopened.get("device-1")?.token).toEqual(results.find((r) => r.accepted).token)
    expect(reopened.history("device-1")).toHaveLength(1)
    reopened.close()
  })

  test("uncertain command blocks reuse after process loss, including cleanup and lease expiry", async () => {
    const db = join(temp(), "device.sqlite"), broker = new LocalDeviceBroker(db, fixtureCapabilities())
    const token = broker.acquire("device-1", "owner-1", new Date(Date.now() + 80).toISOString(), probe)
    broker.begin(token, "install-1", "mutate", probe)
    broker.close() // Process may have dispatched; reopening cannot infer stopped.
    await Bun.sleep(100)
    const reopened = new LocalDeviceBroker(db, fixtureCapabilities())
    expect(() => reopened.acquire("device-1", "owner-2", deadline(), probe)).toThrow("device_lease_unavailable")
    expect(() => reopened.begin(token, "cleanup-1", "cleanup", probe)).toThrow("device_command_in_flight")
    expect(() => reopened.releaseAfterCleanup(token, proof)).toThrow("unknown_command_forbids_release")
    reopened.finish(token, "install-1", "unknown")
    expect(() => reopened.finish(token, "install-1", "completed")).toThrow("device_command_outcome_already_recorded")
    expect(() => reopened.assertCommand(token, "install-1", probe)).toThrow("device_command_not_reserved")
    reopened.close()
  })

  test("cleanup failure quarantines, stale fences and duplicate commands fail, audit cannot be rewritten", () => {
    const db = join(temp(), "device.sqlite"), broker = new LocalDeviceBroker(db, fixtureCapabilities())
    const token = broker.acquire("device-1", "owner-1", deadline(), probe)
    expect(() => broker.begin({ ...token, epoch: 0 }, "stale", "mutate", probe)).toThrow("stale_device_fence")
    broker.begin(token, "cleanup-fault", "cleanup", probe); broker.finish(token, "cleanup-fault", "failed")
    expect(broker.get("device-1")?.status).toBe("quarantined")
    expect(() => broker.begin(token, "new-mutation", "mutate", probe)).toThrow("device_quarantined_or_released")
    expect(() => broker.acquire("device-1", "owner-2", deadline(), probe)).toThrow("device_lease_unavailable")
    expect(() => broker.begin(token, "cleanup-fault", "cleanup", probe)).toThrow("device_command_already_reserved")
    expect(() => broker.begin(token, "bad-mode", "unexpected" as any, probe)).toThrow("invalid_device_command_mode")
    broker.begin(token, "actual-cleanup", "cleanup", probe); broker.finish(token, "actual-cleanup", "completed", proof)
    broker.releaseAfterCleanup(token, proof)
    const next = broker.acquire("device-1", "owner-2", deadline(), probe)
    expect(next.generation).toBe(token.generation + 1)
    expect(next.epoch).toBe(token.epoch + 1)
    expect(() => broker.begin(token, "stale-observe", "observe", probe)).toThrow("stale_device_fence")
    const sql = new Database(db)
    expect(() => sql.exec("DELETE FROM loopit_device_history")).toThrow("device history is immutable")
    expect(() => sql.exec("UPDATE loopit_device_history SET record='{}'")).toThrow("device history is immutable")
    sql.close(); broker.close()
  })

  test("an already reserved mutation must recheck deadline immediately before provider dispatch", async () => {
    const broker = new LocalDeviceBroker(join(temp(), "device.sqlite"), fixtureCapabilities())
    const token = broker.acquire("device-1", "owner-1", new Date(Date.now() + 80).toISOString(), probe)
    broker.begin(token, "install-1", "mutate", probe)
    broker.assertCommand(token, "install-1", probe)
    await Bun.sleep(100)
    expect(() => broker.assertCommand(token, "install-1", probe)).toThrow("device_mutation_not_authorized")
    broker.close()
  })
})

async function fixture(mode: "success" | "query-unknown" | "cleanup-unknown" | "mismatched-artifact" = "success") {
  const root = temp(), db = join(root, "device.sqlite")
  // The reused OpenCode connection must initialize its own empty database first.
  await Effect.runPromise(Ledger.Service.pipe(Effect.provide(Ledger.layerFromPath(db)), Effect.scoped))
  const broker = new LocalDeviceBroker(db, fixtureCapabilities())
  const token = broker.acquire("device-1", "owner-1", deadline(), probe)
  const journalPath = join(root, "journal.sqlite"), { journalId } = initializeDatabase(journalPath)
  const store = new JournalStore(journalPath, journalId)
  store.initializeScope(token.resourceId, { ownerId: token.ownerId, generation: token.generation, epoch: token.epoch }); store.close()
  const journal = createRecoveryJournal({ journalId, transport: localStdioTransport({
    cliPath: resolve("script/m0/recovery-journal.ts"), databasePath: journalPath, journalId, ownerId: token.ownerId,
  }) })
  let installs = 0, queries = 0, unavailableQueries = 0, cleanups = 0
  const artifactDigest = digestOf("frozen app fixture"), saved: Record<string, unknown> = {}
  const save = (name: string, value: unknown) => { saved[name] = value; return { ref: `artifact://fixture/${name}`, digest: digestOf(value) } }
  const result = await Effect.runPromise(Effect.gen(function* () {
    const ledger = yield* Ledger.Service
    let result: unknown, error: unknown
    try {
      result = yield* Effect.promise(() => exerciseIosBrokerProtocol({ broker, token, probe, ledger, artifactDigest, save,
        install: async () => { installs++ },
        unavailableQuery: async () => {
          unavailableQueries++
          expect(installs).toBe(1); expect(queries).toBe(0)
          expect((await Effect.runPromise(ledger.get(`install-${token.leaseId}`)))?.record.state).toBe("indeterminate")
          throw new Error("query_unavailable_fault_before_provider")
        },
        query: async () => {
          queries++
          if (mode === "query-unknown") throw new Error("real query fixture failed")
          return { matched: mode !== "mismatched-artifact", artifactDigest, observedDigest: artifactDigest,
            evidence: save("actual-query.json", { fixture: true }), externalResourceRef: "simulator://device-1/app/fixture" }
        },
        cleanup: async () => { cleanups++; if (mode === "cleanup-unknown") throw new Error("real cleanup fixture failed"); return proof },
      })).pipe(Effect.catchDefect((e) => { error = e; return Effect.succeed(undefined) }))
    } catch (e) { error = e }
    return { result, error, operation: yield* ledger.get(`install-${token.leaseId}`) }
  }).pipe(Effect.provide(Ledger.layerFromPath(db, { journal })), Effect.scoped))
  const lease = broker.get(token.resourceId), history = broker.history(token.resourceId)
  broker.close()
  return { ...result, lease, history, saved, installs, queries, unavailableQueries, cleanups }
}

test("one fixture install, real SQLite + journal process: missing receipt/query outage never redispatch; actual query settles same operation", async () => {
  const f = await fixture()
  expect(f.error).toBeUndefined()
  expect([f.installs, f.unavailableQueries, f.queries, f.cleanups]).toEqual([1, 1, 1, 1])
  expect(f.operation?.record.state).toBe("succeeded")
  expect(f.operation?.history.some((h) => h.action === "reconciled")).toBe(true)
  expect(f.lease?.status).toBe("released")
  expect(f.result).toMatchObject({ osExclusiveControl: false, independentFailureDomain: false, fullM0A08Passed: false, fullM0A10Passed: false,
    checks: { renamedInstallCannotBypassUnknown: { rejected: true }, cleanupFailure: { quarantined: true }, retiredTokenCannotControlNewLease: { rejected: true } } })
}, 20_000)

test.each(["query-unknown", "cleanup-unknown", "mismatched-artifact"] as const)("%s leaves visible quarantine without reinstall or lease reassignment", async (mode) => {
  const f = await fixture(mode)
  expect(f.error).toBeDefined()
  expect(f.installs).toBe(1)
  expect(f.lease?.status).toBe("quarantined")
  expect(f.lease?.token.generation).toBe(1)
  expect(f.operation?.record.state).toBe(mode === "cleanup-unknown" ? "succeeded" : "indeterminate")
  if (mode !== "mismatched-artifact") expect(f.lease?.inFlight).toBeDefined()
}, 20_000)

test.skipIf(process.platform !== "darwin")("default CLI writes a frozen plan with no device command; changed target or bytes cannot be substituted", async () => {
  const root = temp(), app = join(root, "Fixture.app"), out = join(root, "plan")
  mkdirSync(app)
  const plist = { CFBundleIdentifier: TARGET.bundleId, CFBundleShortVersionString: "1", CFBundleVersion: "1",
    CFBundleExecutable: "Fixture", DTPlatformName: "iphonesimulator", MinimumOSVersion: "15" }
  writeFileSync(join(app, "Info.plist"), JSON.stringify(plist))
  writeFileSync(join(app, "Fixture"), "never-executed fixture")
  writeFileSync(join(app, "main.jsbundle"), "never-executed fixture")
  const child = Bun.spawn([process.execPath, resolve("script/m0/ios-broker-experiment.ts"), "--artifact", app, "--out", out], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
  expect(JSON.parse(stdout)).toMatchObject({ status: "prepared-only", deviceCommandsDispatched: 0 })
  const report = JSON.parse(readFileSync(join(out, "result.json"), "utf8"))
  expect(report.operations).toEqual([])
  const plan = JSON.parse(readFileSync(join(out, "plan.json"), "utf8")), inventory = JSON.parse(readFileSync(join(out, "source-app-inventory.json"), "utf8"))
  expect(validateExperimentPlan(plan, inventory)).toBe(true)
  expect(() => validateExperimentPlan({ ...plan, target: { ...plan.target, udid: "another" } }, inventory)).toThrow("Frozen plan")
  expect(() => validateExperimentPlan(plan, { ...inventory, digest: digestOf("changed bytes") })).toThrow("Frozen plan")
  expect(() => validateExperimentPlan({ ...plan, maximumMinutes: 60 }, inventory)).toThrow("Frozen plan")
})
