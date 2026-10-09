/** Prepare only. Root installation and execution are separate reviewed steps. */
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { byteDigest } from "../../packages/verifier/src/service"
import { HISTORICAL_INPUTS, HISTORICAL_JOB, type ReadonlyAcceptancePlan } from "./control-loop-acceptance"
import { originalSignedCheckPin } from "./readonly-acceptance-inputs"

const args = process.argv.slice(2)
if (args.length !== 4 || args[0] !== "--out" || args[2] !== "--id" || !args[1].startsWith("/") ||
    existsSync(args[1]) || !/^[a-z0-9][a-z0-9-]{0,70}$/.test(args[3])) throw new Error("Expected --out <new absolute directory> --id <installation suffix>")
const root = resolve(import.meta.dir, "../.."), out = args[1]
const installRoot = `/private/var/loopit/readonly-acceptance-${args[3]}`
const exports = "/private/var/loopit/verifier-deployment-export"
const trust = JSON.parse(readFileSync("/private/var/loopit/verifier-deployment-trust.json", "utf8"))
const names = { goal: "goal.json", source: "source.ts", tests: "tests.json", publicKey: "publicKey.pem", signedCheck: "signedCheck.json", evidence: "evidence.json", result: "result.json", execution: "execution.json", budget: "runBudget.json" }
const spec = JSON.parse(readFileSync(join(exports, "runSpec.json"), "utf8"))
const inputs = Object.fromEntries(Object.entries(HISTORICAL_INPUTS).map(([role, path]) => {
  const bytes = readFileSync(join(exports, names[role as keyof typeof names]))
  const trustedRole = role === "budget" ? "runBudget" : role
  if (trust.artifacts.find((a: any) => a.role === trustedRole)?.digest !== byteDigest(bytes)) throw new Error("Export differs from existing protected trust pin")
  return [role, { path, digest: byteDigest(bytes) }]
})) as ReadonlyAcceptancePlan["inputs"]
if (trust.current.status !== "applied-not-executed" || trust.jobRoot !== HISTORICAL_JOB || spec.runId !== trust.binding.runId) throw new Error("Historical deployment binding changed")
// The public export intentionally reserialized signedCheck. Its trust pin is
// not the original protected report's byte pin. Root's first attempted install
// observed this exact original digest; preserve both representations unchanged.
const originalSignedPath = join(root, ".bench/m0-fixes/control-loop-actual/code-task-passed/reports/signed-check.json")
const signedCheckPinProvenance = originalSignedCheckPin(readFileSync(originalSignedPath), readFileSync(join(exports, names.signedCheck)),
  "sha256:f19125bc50b68d47f470a1820b120996ee885626395198e1cd47ff2926a0e9c4", inputs.signedCheck.digest,
  readFileSync(join(exports, names.publicKey), "utf8"), { binding: trust.binding, keyId: trust.keyId,
    candidateDigest: JSON.parse(readFileSync(join(exports, names.result), "utf8")).candidateDigest, testsDigest: inputs.tests.digest })
inputs.signedCheck.digest = signedCheckPinProvenance.originalDigest
mkdirSync(out, { mode: 0o700 })
const stage = realpathSync(out)
const sourceFiles = ["script/m0/control-loop.ts", "script/m0/control-loop-acceptance.ts", "packages/verifier/src/service.ts", "script/m0/prepare-readonly-acceptance.ts", "script/m0/readonly-acceptance-inputs.ts", "script/macos/install-readonly-acceptance.py", "script/test/control-loop-acceptance.test.ts"]
const sourceDigests = Object.fromEntries(sourceFiles.map(path => [path, byteDigest(readFileSync(join(root, path)))]))
const result = await Bun.build({ entrypoints: [join(root, "script/m0/control-loop.ts")], target: "bun", format: "esm", packages: "bundle", splitting: false, sourcemap: "none" })
if (!result.success || result.outputs.length !== 1) throw new Error("Read-only controller bundle failed")
const bytes = Buffer.from(await result.outputs[0].arrayBuffer())
writeFileSync(join(stage, "controller.mjs"), bytes, { mode: 0o600, flag: "wx" })
const plan: ReadonlyAcceptancePlan & { installRoot: string; installerDigest: string; signedCheckPinProvenance: typeof signedCheckPinProvenance } = {
  schemaVersion: "m0-readonly-acceptance/1", installRoot, runId: spec.runId, keyId: spec.verifierKeyId,
  controllerDigest: byteDigest(bytes), historicalControllerDigest: trust.historical.controllerDigest,
  untouchedUpdate9ControllerDigest: trust.current.controllerDigest, bun: spec.bun, inputs, sourceDigests,
  installerDigest: sourceDigests["script/macos/install-readonly-acceptance.py"],
  signedCheckPinProvenance,
}
writeFileSync(join(stage, "plan.json"), JSON.stringify(plan, null, 2) + "\n", { mode: 0o600, flag: "wx" })
copyFileSync(join(root, "script/macos/install-readonly-acceptance.py"), join(stage, "install-readonly-acceptance.py"), constants.COPYFILE_EXCL)
console.log(JSON.stringify({ status: "prepared-not-installed", stage, installRoot,
  planDigest: byteDigest(readFileSync(join(stage, "plan.json"))), controllerDigest: plan.controllerDigest,
  installerDigest: plan.installerDigest, modelCalls: 0, signingCalls: 0, originalDeploymentModified: false }))
