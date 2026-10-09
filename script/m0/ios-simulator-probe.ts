// Operator-driven M0 capability probe. This is not an autonomous Device Broker,
// independent recovery journal, trusted InstallReceipt, or signed Gate.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { runProcess } from "../../packages/sandbox/src/process"
import { byteDigest, compareApps, inspectApp } from "./ios-artifact"

const args = process.argv.slice(2)
function option(name: string) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
const artifact = option("--artifact")
const output = option("--out")
if (!artifact || !output) throw new Error("Usage: --artifact <app> --out <new-report-directory> [--run]")
const out = resolve(output)
if (existsSync(out)) throw new Error("Output exists; inspect earlier operations before a new probe. Automatic retry is disabled.")
mkdirSync(out, { recursive: true, mode: 0o700 })
const write = (name: string, value: unknown) => {
  const path = join(out, name)
  writeFileSync(path + ".tmp", JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  renameSync(path + ".tmp", path)
}
const report: any = { schemaVersion: "ios-simulator-probe/1", startedAt: new Date().toISOString(), status: "preparing",
  autonomousBroker: false, signedGate: false, operations: [], checks: {},
  limitations: ["Local operator capability probe; no broker lease/epoch or independent recovery journal.",
    "Installed byte identity does not prove device UI semantics or an independent verifier signing identity."],
}
const save = () => write("result.json", report)
let device: string | undefined
async function applications(label: string) {
  // simctl returns an OpenStep property list, not JSON. Convert with Apple's parser.
  const raw = await simctl(label, ["listapps", device!])
  const plist = join(out, `${label}.plist`)
  writeFileSync(plist, raw, { mode: 0o600 })
  const json = join(out, `${label}.json`)
  const converted = await runProcess(["/usr/bin/plutil", "-convert", "json", "-o", json, plist])
  if (converted.code !== 0 || converted.error || converted.timedOut) throw new Error("App inventory could not be parsed completely")
  return JSON.parse(readFileSync(json, "utf8"))
}
async function simctl(operation: string, argv: string[], timeoutMs = 60000) {
  // Persist the intended action before dispatch. Uncertain outcomes are never retried here.
  const event: any = { operation, argv, startedAt: new Date().toISOString(), status: "dispatching" }
  report.operations.push(event); save()
  const result = await runProcess(["/usr/bin/xcrun", "simctl", ...argv], { timeoutMs })
  Object.assign(event, { ...result, finishedAt: new Date().toISOString(),
    status: result.code === 0 && !result.signal && !result.timedOut && !result.error ? "completed" : "indeterminate" })
  save()
  if (event.status !== "completed") throw new Error(`${operation} did not complete; inspect result.json before any retry`)
  return result.stdout.trim()
}
async function installed(expected: Awaited<ReturnType<typeof inspectApp>>, label: string) {
  const path = await simctl(`inspect-${label}`, ["get_app_container", device!, expected.identity.bundleId, "app"])
  const observed = await inspectApp(path)
  write(`${label}-inventory.json`, observed)
  const comparison = compareApps(expected, observed)
  report.checks[label] = { ...comparison, observedDigest: observed.digest, expectedDigest: expected.digest }; save()
  return comparison
}
async function main() {
  const expected = await inspectApp(resolve(artifact!))
  write("build-inventory.json", expected)
  report.buildDigest = expected.digest
  report.buildIdentity = expected.identity
  if (expected.identity.bundleId !== "com.seedleap.loopitapp.test" || expected.identity.platform !== "iphonesimulator" || expected.identity.jsBundles.length !== 1)
    throw new Error("Probe only accepts the Loopit test simulator app with one embedded JS bundle")
  if (!args.includes("--run")) { report.status = "prepared"; save(); return }
  if (process.platform !== "darwin") throw new Error("iOS simulator probe requires macOS")
  const runtime = "com.apple.CoreSimulator.SimRuntime.iOS-26-0"
  const deviceType = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"
  const resume = option("--reuse-empty-probe-device")
  let state = "Shutdown"
  if (resume) {
    const previous = JSON.parse(readFileSync(resolve(resume), "utf8"))
    const d = previous.device
    if (previous.schemaVersion !== "ios-simulator-probe/1" || !d?.createdByThisProbe ||
        !/^Loopit M0 /.test(d.name) || !/^[A-F0-9-]{36}$/i.test(d.udid) || d.runtime !== runtime || d.deviceType !== deviceType ||
        previous.operations.some((entry: any) => entry.argv?.[0] === "install"))
      throw new Error("Only an explicitly inspected, created-but-never-installed probe device can be reused")
    const devices = JSON.parse(await simctl("inspect-empty-probe-device", ["list", "devices", "-j"]))
    const live = devices.devices[runtime]?.find((entry: any) => entry.udid === d.udid)
    if (!live || live.name !== d.name || live.deviceTypeIdentifier !== deviceType || !live.isAvailable)
      throw new Error("Previous probe device no longer matches its recorded identity")
    state = live.state
    device = d.udid
    report.device = d
    report.reusedEmptyDeviceFrom = { path: resolve(resume), digest: byteDigest(readFileSync(resolve(resume))) }; save()
  } else {
    const name = `Loopit M0 ${new Date().toISOString().replace(/[:.]/g, "-")}`
    device = await simctl("create-dedicated-device", ["create", name, deviceType, runtime])
    if (!/^[A-F0-9-]{36}$/i.test(device)) throw new Error("Unexpected created device identity")
    report.device = { udid: device, name, runtime, deviceType, createdByThisProbe: true }; save()
  }
  if (!device) throw new Error("Device identity is missing")
  if (state === "Shutdown") await simctl("boot", ["boot", device!])
  else if (state !== "Booted") throw new Error(`Device is in uncertain state ${state}`)
  await simctl("wait-until-booted", ["bootstatus", device])
  const before = await applications("list-before-install")
  if (before[expected.identity.bundleId]) throw new Error("New device unexpectedly already has the target app")
  report.checks.initialAppAbsent = true; save()
  await simctl("install-baseline", ["install", device, expected.root])
  if (!(await installed(expected, "baseline")).matched) throw new Error("Installed baseline differs from built package")
  await simctl("launch-baseline", ["launch", device, expected.identity.bundleId])
  await simctl("screenshot", ["io", device, "screenshot", join(out, "baseline.png")])
  report.screenshot = { path: "baseline.png", digest: byteDigest(readFileSync(join(out, "baseline.png"))),
    interpretation: "Immediate post-launch observation; readiness is not established." }; save()
  await simctl("terminate-baseline", ["terminate", device, expected.identity.bundleId])

  // A real same-version replacement must fail byte-identity reconciliation.
  // It is deliberately never launched. Restore the original bytes afterward.
  const replacement = join(out, "mismatch.app")
  cpSync(expected.root, replacement, { recursive: true, dereference: false })
  const jsPath = join(replacement, expected.identity.jsBundles[0].path)
  writeFileSync(jsPath, Buffer.concat([readFileSync(jsPath), Buffer.from("\nM0_NON_EXECUTED_IDENTITY_MISMATCH\n")]))
  await simctl("install-same-version-different-bundle", ["install", device, replacement])
  const mismatch = await installed(expected, "replacement")
  if (mismatch.matched || !mismatch.differingPaths.includes(expected.identity.jsBundles[0].path))
    throw new Error("Modified JS bundle was not rejected by byte identity")
  report.checks.sameVersionReplacementRejected = true; save()
  await simctl("restore-baseline", ["install", device, expected.root])
  if (!(await installed(expected, "restored")).matched) throw new Error("Restored baseline differs from built package")
  await simctl("uninstall", ["uninstall", device, expected.identity.bundleId])
  const after = await applications("list-after-uninstall")
  if (after[expected.identity.bundleId]) throw new Error("App still present after uninstall")
  report.checks.uninstallConfirmed = true; save()
  await simctl("shutdown", ["shutdown", device])
  const devices = JSON.parse(await simctl("inspect-cleanup", ["list", "devices", "-j"]))
  const actual = devices.devices[runtime]?.find((entry: any) => entry.udid === device)
  if (actual?.state !== "Shutdown") throw new Error("Device shutdown not independently confirmed")
  report.cleanup = { appAbsent: true, deviceState: "Shutdown", retainedDedicatedDevice: device, existingDevicesModified: false }
  report.status = "capability-probe-passed"; report.finishedAt = new Date().toISOString(); save()
}
try { await main(); console.log(JSON.stringify({ status: report.status, report: join(out, "result.json"), device: report.device?.udid })) }
catch (error) {
  report.status = "blocked"; report.error = error instanceof Error ? error.message : String(error)
  report.cleanup = { confirmed: false, device: device ?? null, requiresInspection: true }
  save(); console.error(report.error); process.exitCode = 2
}
