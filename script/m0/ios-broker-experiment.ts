/** Explicit operator experiment. Default mode inspects files and writes a plan;
 * --run requires that frozen plan. No UI, model, admin or network operations.
 * Broker-entry serialization is NOT exclusive OS control of CoreSimulator. */
import { cpSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { Effect } from "effect"
import { canonicalJson, digestOf } from "../../packages/contracts/src/digest"
import type * as Ledger from "../../packages/delivery/src/operation-ledger"
import { initializeDatabase, JournalStore } from "../../packages/recovery-journal/src/store"
import { createRecoveryJournal, localStdioTransport } from "../../packages/recovery-journal/src/port"
import { LocalDeviceBroker, type DeviceToken } from "./local-device-broker"
import { DeviceCapabilityRegistry, type OperatorProbeUse } from "./device-capabilities"
import { exerciseIosBrokerProtocol } from "./ios-broker-protocol"
import { byteDigest, compareApps, inspectApp } from "./ios-artifact"

export const TARGET = Object.freeze({ udid: "62F1C107-7480-41BD-B2E2-6C3323B8ECDA", bundleId: "com.seedleap.loopitapp.test",
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0", deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro" })
const repository = resolve(import.meta.dir, "../..")
const defaultArtifact = join(repository, ".bench/m0-fixes/ios-derived-data/Build/Products/ReleaseTest-iphonesimulator/Loopit (Test).app")
// This path is shared by every invocation: changing --out cannot bypass a lease.
const brokerDatabase = join(repository, ".bench/m0-device-broker/device.sqlite")
const limitations = [
  "Lease/fence excludes other callers of this local Broker only; the operator OS UID can still call simctl directly.",
  "The recovery journal uses a separate local process and SQLite file on this host, not an independent failure/credential domain.",
  "Receipt loss, provider query outage and cleanup failure are explicit boundary fault injections, not actual OS crashes.",
  "The local simulator installation is the selected real delivery channel. This experiment is not yet bound to the formal Task/Run and signed Gate; no UI semantic/drift checks here.",
  "Unknown in-flight commands or failed cleanup remain quarantined. This script cannot unlock or automatically retry an earlier execution.",
]
function assertArtifact(app: Awaited<ReturnType<typeof inspectApp>>) {
  if (app.identity.bundleId !== TARGET.bundleId || app.identity.platform !== "iphonesimulator" || app.identity.jsBundles.length !== 1)
    throw new Error("Only the frozen Loopit test simulator app with one embedded JS bundle is supported")
}
export function validateExperimentPlan(plan: any, app: Awaited<ReturnType<typeof inspectApp>>) {
  assertArtifact(app)
  if (plan?.schemaVersion !== "ios-broker-experiment-plan/1" || digestOf(plan.target) !== digestOf(TARGET) ||
      plan.brokerDatabase !== brokerDatabase || plan.artifact?.root !== app.root || plan.artifact?.digest !== app.digest ||
      digestOf(plan.artifact?.identity ?? null) !== digestOf(app.identity) || plan.maximumMinutes !== 10 || plan.operatorProbeOnly !== true)
    throw new Error("Frozen plan no longer matches the fixed device, database, artifact or budget")
  return true
}
function syncFile(path: string, bytes: string | Buffer, exclusive = true) {
  const fd = openSync(path, exclusive ? "wx" : "w", 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  const parent = openSync(dirname(path), "r")
  try { fsyncSync(parent) } finally { closeSync(parent) }
}

async function main() {
  const args = process.argv.slice(2)
  const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
  if (args.includes("--help")) {
    console.log("Prepare only: bun script/m0/ios-broker-experiment.ts --out <new-plan-directory> [--artifact <app>]\nExplicit device run: bun script/m0/ios-broker-experiment.ts --run --plan <plan.json> --out <new-result-directory>")
    return
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--run") continue
    if (!["--out", "--artifact", "--plan"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Unknown or missing argument")
    i++
  }
  const output = option("--out"), running = args.includes("--run")
  if (!output || (running && (!option("--plan") || option("--artifact")))) throw new Error("A new --out is required; --run needs --plan and cannot replace its artifact")
  const out = resolve(output)
  if (existsSync(out)) throw new Error("Output already exists; no automatic retry or overwrite")
  mkdirSync(out, { recursive: true, mode: 0o700 })
  const experimentId = randomUUID(), startedAt = new Date().toISOString()
  const save = (name: string, value: unknown): Ledger.DurableRef => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error("Invalid evidence filename")
    const bytes = canonicalJson(value)
    syncFile(join(out, name), bytes)
    return { ref: `artifact://${experimentId}/${name}`, digest: byteDigest(Buffer.from(bytes)) }
  }
  const report: any = { schemaVersion: "ios-broker-experiment/1", experimentId, startedAt, target: TARGET, status: "preparing",
    brokerDatabase, osExclusiveControl: false, independentFailureDomain: false, fullM0A08Passed: false, fullM0A10Passed: false,
    limitations, operations: [], actualInstallCount: 0, actualQueryCount: 0 }
  const snapshot = () => {
    const file = join(out, "result.json"), temporary = file + ".tmp"
    syncFile(temporary, canonicalJson(report), false); renameSync(temporary, file)
    const fd = openSync(out, "r"); try { fsyncSync(fd) } finally { closeSync(fd) }
  }
  let broker: LocalDeviceBroker | undefined, token: DeviceToken | undefined
  try {
    const planPath = option("--plan") ? resolve(option("--plan")!) : undefined
    const plan = planPath ? JSON.parse(readFileSync(planPath, "utf8")) : undefined
    const app = await inspectApp(running ? plan?.artifact?.root : resolve(option("--artifact") ?? defaultArtifact))
    assertArtifact(app)
    report.artifact = save("source-app-inventory.json", app)
    if (!running) {
      save("plan.json", { schemaVersion: "ios-broker-experiment-plan/1", createdAt: startedAt, target: TARGET,
        artifact: { root: app.root, digest: app.digest, identity: app.identity }, brokerDatabase, maximumMinutes: 10, operatorProbeOnly: true,
        actions: ["Require selected device Shutdown and target app absent", "Acquire fixed-database lease; reject competing owner/stale fence",
          "Install exactly once, drop ledger receipt, inject query unavailability, reject redispatch and renamed operation",
          "Query installed package and compare all app bytes", "Inject cleanup failure; require quarantine", "Uninstall, confirm absence, shutdown, confirm state, then release"],
        limitations })
      report.status = "prepared-only"; snapshot()
      console.log(JSON.stringify({ status: report.status, plan: join(out, "plan.json"), deviceCommandsDispatched: 0 })); return
    }
    validateExperimentPlan(plan, app)
    if (process.platform !== "darwin" || !process.getuid || process.getuid() === 0) throw new Error("Run only as the ordinary macOS operator, never root")
    report.plan = { path: planPath, digest: byteDigest(readFileSync(planPath!)) }
    const frozenPath = join(out, "candidate.app")
    cpSync(app.root, frozenPath, { recursive: true, dereference: false, errorOnExist: true, force: false })
    const frozen = await inspectApp(frozenPath)
    if (!compareApps(app, frozen).matched) throw new Error("Copied candidate does not match frozen artifact")
    report.frozenArtifact = save("frozen-app-inventory.json", frozen)
    // Isolate reused OpenCode database/config initialization from personal XDG.
    for (const [key, directory] of Object.entries({ XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_STATE_HOME: "state", XDG_CACHE_HOME: "cache" })) {
      process.env[key] = join(out, "host-xdg", directory); mkdirSync(process.env[key]!, { recursive: true, mode: 0o700 })
    }
    const LedgerModule = await import("../../packages/delivery/src/operation-ledger")
    const parent = dirname(brokerDatabase)
    if (existsSync(parent) && (lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory())) throw new Error("Broker parent must be a regular directory")
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    await Effect.runPromise(LedgerModule.Service.pipe(Effect.provide(LedgerModule.layerFromPath(brokerDatabase)), Effect.scoped))
    // Explicit operator scope is not a production authorization or OS proof.
    const capabilities = new DeviceCapabilityRegistry([{ resourceId: TARGET.udid, observedAt: startedAt, osExclusiveControl: false,
      sourceRefs: [{ ref: `artifact://${experimentId}/operator-plan.json`, digest: report.plan.digest }] }])
    const probe: OperatorProbeUse = { purpose: "operator-probe-only", experimentId }
    report.deviceCapability = capabilities.describe(TARGET.udid)
    broker = new LocalDeviceBroker(brokerDatabase, capabilities)
    token = broker.acquire(TARGET.udid, `experiment-${experimentId}`, new Date(Date.now() + 10 * 60_000).toISOString(), probe)
    report.lease = token; report.status = "leased"; snapshot()
    const journalPath = join(out, "recovery-journal.sqlite"), { journalId } = initializeDatabase(journalPath)
    const store = new JournalStore(journalPath, journalId)
    try { store.initializeScope(TARGET.udid, { ownerId: token.ownerId, generation: token.generation, epoch: token.epoch }) } finally { store.close() }
    report.journal = { path: journalPath, journalId, independentFailureDomain: false }; snapshot()
    const journal = createRecoveryJournal({ journalId, transport: localStdioTransport({
      cliPath: join(repository, "script/m0/recovery-journal.ts"), databasePath: journalPath, journalId, ownerId: token.ownerId }) })
    let sequence = 0
    const simctl = (operationId: string, label: string, argv: string[], timeoutMs = 60_000) => {
      broker!.assertCommand(token!, operationId, probe)
      // All callers below are fixed host code. No model can select an argv/UDID.
      const entry: any = { sequence: ++sequence, operationId, label, argv, startedAt: new Date().toISOString(), state: "dispatching" }
      report.operations.push(entry); snapshot()
      const prefix = `command-${String(sequence).padStart(3, "0")}`
      entry.intent = save(`${prefix}-intent.json`, { operationId, token, label, argv, startedAt: entry.startedAt })
      const remaining = Date.parse(token!.deadlineAt) - Date.now()
      if (remaining <= 0) throw new Error("Experiment absolute deadline exceeded; manual inspection required")
      const result = spawnSync("/usr/bin/xcrun", ["simctl", ...argv], { encoding: "buffer", timeout: Math.min(timeoutMs, remaining),
        killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME!,
          TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "en_US.UTF-8" } })
      const stdout = result.stdout ?? Buffer.alloc(0), stderr = result.stderr ?? Buffer.alloc(0)
      syncFile(join(out, `${prefix}.stdout`), stdout); syncFile(join(out, `${prefix}.stderr`), stderr)
      Object.assign(entry, { exitCode: result.status, signal: result.signal, errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null,
        outputIncomplete: !!result.error, stdout: { path: `${prefix}.stdout`, digest: byteDigest(stdout), bytes: stdout.length },
        stderr: { path: `${prefix}.stderr`, digest: byteDigest(stderr), bytes: stderr.length }, finishedAt: new Date().toISOString(),
        state: result.status === 0 && !result.signal && !result.error ? "completed" : "indeterminate" })
      entry.receipt = save(`${prefix}-receipt.json`, entry); snapshot()
      if (entry.state !== "completed") throw new Error(`${label}: provider result unknown or failed; no retry (${entry.errorCode ?? entry.exitCode ?? entry.signal})`)
      return stdout.toString("utf8").trim()
    }
    const command = async <T>(label: string, mode: "observe" | "mutate" | "cleanup", fn: (operationId: string) => Promise<T> | T) => {
      const operationId = `${label}-${token!.leaseId}`
      broker!.begin(token!, operationId, mode, probe)
      try { const result = await fn(operationId); broker!.finish(token!, operationId, "completed"); return result }
      catch (error) { broker!.finish(token!, operationId, "unknown"); throw error }
    }
    const selectedDevice = (operationId: string, label: string) => {
      const listing = JSON.parse(simctl(operationId, label, ["list", "devices", "-j"]))
      const device = listing.devices?.[TARGET.runtime]?.find((d: any) => d.udid === TARGET.udid)
      if (!device || device.deviceTypeIdentifier !== TARGET.deviceType || !device.isAvailable || !/^Loopit M0 /.test(device.name))
        throw new Error("Selected dedicated simulator identity changed")
      return device
    }
    const applications = (operationId: string, label: string) => {
      const raw = simctl(operationId, label, ["listapps", TARGET.udid]), path = join(out, `${label}.plist`)
      syncFile(path, raw)
      const parsed = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8", timeout: 5_000, maxBuffer: 8 * 1024 * 1024 })
      if (parsed.status !== 0 || parsed.signal || parsed.error) throw new Error("Full app inventory unavailable")
      const apps = JSON.parse(parsed.stdout); save(`${label}.json`, apps); return apps
    }
    const initial = await command("inspect-device", "observe", (id) => selectedDevice(id, "inspect-initial-device"))
    if (initial.state !== "Shutdown") throw new Error("Dedicated simulator must initially be Shutdown; no current session will be interrupted")
    report.initialDevice = initial; snapshot()
    await command("boot", "mutate", (id) => simctl(id, "boot", ["boot", TARGET.udid]))
    await command("wait-boot", "observe", (id) => { simctl(id, "wait-boot", ["bootstatus", TARGET.udid]);
      if (selectedDevice(id, "verify-boot").state !== "Booted") throw new Error("Boot state not confirmed") })
    const before = await command("inventory-before", "observe", (id) => applications(id, "apps-before"))
    if (before[TARGET.bundleId]) throw new Error("Target app already exists; cannot prove ownership of data or authorize uninstall")
    report.initialAppAbsent = true; snapshot()
    const protocol = await Effect.runPromise(Effect.gen(function* () {
      const ledger = yield* LedgerModule.Service
      return yield* Effect.tryPromise(() => exerciseIosBrokerProtocol({ broker: broker!, token: token!, probe, ledger, artifactDigest: frozen.digest, save,
        install: async () => {
          // Rehash immediately before use; a changed build never becomes receipt evidence.
          if (!compareApps(frozen, await inspectApp(frozen.root)).matched) throw new Error("Candidate changed before installation")
          report.actualInstallCount++; snapshot()
          simctl(`install-${token!.leaseId}`, "install-once", ["install", TARGET.udid, frozen.root])
        },
        unavailableQuery: async () => { throw new Error("query_unavailable_fault_before_provider") },
        query: async () => {
          report.actualQueryCount++; snapshot()
          const installed = simctl(`query-${token!.leaseId}`, "query-installed-package", ["get_app_container", TARGET.udid, TARGET.bundleId, "app"])
          const observed = await inspectApp(installed), comparison = compareApps(frozen, observed)
          const inventoryRef = save("installed-app-inventory.json", observed)
          const evidence = save("actual-installed-query.json", { comparison, expectedDigest: frozen.digest, observedDigest: observed.digest, inventoryRef, deviceId: TARGET.udid })
          return { matched: comparison.matched, artifactDigest: frozen.digest, observedDigest: observed.digest, evidence,
            externalResourceRef: `simulator://${TARGET.udid}/app/${TARGET.bundleId}` }
        },
        cleanup: async () => {
          const id = `cleanup-${token!.leaseId}`
          simctl(id, "uninstall", ["uninstall", TARGET.udid, TARGET.bundleId])
          if (applications(id, "apps-after")[TARGET.bundleId]) throw new Error("Uninstall absence not confirmed")
          simctl(id, "shutdown", ["shutdown", TARGET.udid])
          if (selectedDevice(id, "verify-shutdown").state !== "Shutdown") throw new Error("Shutdown not confirmed")
          return save("actual-cleanup.json", { deviceId: TARGET.udid, bundleId: TARGET.bundleId, appAbsent: true, state: "Shutdown", observedAt: new Date().toISOString(),
            operationIds: report.operations.filter((e: any) => e.operationId === id).map((e: any) => e.receipt), osExclusiveControl: false })
        },
      }))
    }).pipe(Effect.provide(LedgerModule.layerFromPath(brokerDatabase, { journal })), Effect.scoped))
    report.protocol = protocol; report.protocolEvidence = save("protocol-result.json", protocol)
    report.brokerHistory = save("broker-history.json", broker.history(TARGET.udid)); report.finalLease = broker.get(TARGET.udid)
    if (report.actualInstallCount !== 1 || report.actualQueryCount !== 1) throw new Error("Unexpected install/query count")
    report.status = "local-protocol-experiment-passed"; report.finishedAt = new Date().toISOString(); snapshot()
    console.log(JSON.stringify({ status: report.status, report: join(out, "result.json"), fullM0A08Passed: false, fullM0A10Passed: false }))
  } catch (error) {
    report.status = "blocked"; report.error = error instanceof Error ? error.message : String(error)
    if (broker && token) {
      try {
        if (broker.get(token.resourceId)?.status !== "released") broker.quarantine(token, "experiment_failed_requires_inspection")
        report.finalLease = broker.get(token.resourceId)
      } catch (quarantineError) { report.quarantineError = quarantineError instanceof Error ? quarantineError.message : String(quarantineError) }
    }
    report.cleanupConfirmed = false; report.automaticRetryAllowed = false; snapshot()
    console.error(report.error); process.exitCode = 2
  } finally { broker?.close() }
}
if (import.meta.main) await main()
