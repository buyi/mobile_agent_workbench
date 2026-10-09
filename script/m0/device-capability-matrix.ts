/** Read-only device capability assessment; never invokes simctl or changes a
 * lease. Exit 2 is the expected production-blocked result for current evidence.
 * bun script/m0/device-capability-matrix.ts --result <result.json> --audit <evidence-audit.json> --out <NEW matrix.json>
 */
import { writeFileSync } from "node:fs"
import { registryFromIosObservation } from "./device-capabilities"

function main() {
  const args = process.argv.slice(2)
  if (args.length !== 6 || args[0] !== "--result" || args[2] !== "--audit" || args[4] !== "--out")
    throw new Error("Usage: --result <ios result.json> --audit <evidence-audit.json> --out <NEW matrix.json>")
  const { registry, registration } = registryFromIosObservation(args[1], args[3])
  const report = { schemaVersion: "device-capability-matrix/1", observedAt: new Date().toISOString(),
    verdict: "blocked", resources: [registry.describe(registration.resourceId)],
    autonomousDispatchAllowed: false, deviceCommandsDispatched: 0, administratorCalls: 0,
    requiredBeforeAutonomous: ["Verified dedicated device OS identity and private device-set/IPC boundary",
      "Protected fixed-command proxy with goal/Run/fence binding and no arbitrary argv",
      "Actual untrusted-UID bypass denials plus positive authorized device commands",
      "Fresh observation/action and stop/reconciliation/cleanup tests on the selected local simulator channel"],
    fullM0A07Passed: false, fullM0A08Passed: false, fullM0A10Passed: false, milestonePassed: false }
  writeFileSync(args[5], JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  console.log(JSON.stringify({ verdict: "blocked", reason: "device_os_exclusivity_unproven", report: args[5], deviceCommandsDispatched: 0 }))
  process.exitCode = 2
}
if (import.meta.main) try { main() } catch (error) { console.error(String(error)); process.exitCode = 1 }
