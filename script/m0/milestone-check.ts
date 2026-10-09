import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { checkM0Milestone } from "../../packages/contracts/src/milestone-check"
import { deploymentScopeMatches, readVerifierDeployment, type DeploymentRegistration } from "../../packages/verifier/src/deployment"

// Resolve existing ancestors too: a not-yet-created output under a symlink can
// otherwise alias the artifact root. Broken symlinks fail closed via realpath.
function canonicalPath(path: string): string {
  try { lstatSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return join(canonicalPath(dirname(path)), basename(path))
  }
  return realpathSync(path)
}
const contains = (parent: string, child: string) => {
  const rel = relative(parent, child)
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))
}
const overlaps = (a: string, b: string) => contains(a, b) || contains(b, a)

/** The trust anchor is configured by an operator/CI, never read from submitted evidence. */
export async function milestoneCheck(flags: Record<string, string>, context: { root: string; environment: { sourceRevision: string } & Record<string, unknown> }) {
  const started = new Date()
  const out = resolve(flags.out ?? join(context.root, ".bench", "milestone-M0", started.toISOString().replace(/[:.]/g, "-")))
  const inputPath = (name: string) => flags[name] ? resolve(flags[name]) : undefined
  const specPath = join(context.root, "docs/milestones/m0-contracts-and-integration.md")
  const artifactRoot = inputPath("artifact-root") ?? (inputPath("attestation") ? dirname(inputPath("attestation")!) : undefined)
  const inputs = [...["manifest", "attestation", "goal", "cost-policy", "trusted-public-key", "verifier-deployment"].map(inputPath),
    ...(inputPath("verifier-deployment") ? [dirname(inputPath("verifier-deployment")!)] : []), specPath, artifactRoot].filter((path): path is string => !!path)
  let canonicalOut: string
  const outputIsSeparate = () => inputs.every((path) => !overlaps(canonicalPath(path), canonicalPath(out)))
  try {
    // Every invocation owns a new directory, including blocked reports. Never
    // reuse an empty directory or overwrite artifacts from an earlier run.
    let exists = false
    try { lstatSync(out); exists = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    if (exists || !outputIsSeparate()) throw new Error("unsafe output directory")
    canonicalOut = canonicalPath(out)
  } catch {
    console.error("blocked: --out must be a new directory separate from every input and the artifact root (including path aliases)")
    return 2
  }
  let trustedVerifier: { id: string; publicKeyPem: string } | undefined
  if (flags["trusted-public-key"] && flags["verifier-id"]) {
    try { trustedVerifier = { id: flags["verifier-id"], publicKeyPem: readFileSync(inputPath("trusted-public-key")!, "utf8") } }
    catch { /* The checker records the missing usable trust anchor as blocked. */ }
  }
  let deployment: DeploymentRegistration | undefined, independentVerifierEstablished = false
  if (inputPath("verifier-deployment")) {
    deployment = readVerifierDeployment(inputPath("verifier-deployment")!)
    let goal: unknown
    try { goal = JSON.parse(readFileSync(inputPath("goal")!, "utf8")) } catch { /* Scope remains unregistered. */ }
    if (deploymentScopeMatches(deployment, goal, flags["run-id"])) {
      // The protected index supplies this exact signer, goal and Run. A CLI key
      // cannot widen its scope or replace the index's public trust anchor.
      trustedVerifier = { id: deployment.verifier!.id, publicKeyPem: deployment.verifier!.publicKeyPem }
      independentVerifierEstablished = true
    } else if (deployment.established) deployment.issues.push("deployment_scope_does_not_match_requested_goal_run")
  }
  let result: Record<string, any>
  let exitCode = 2
  try {
    if (flags.milestone !== "M0") {
      result = { schemaVersion: "m0-check-result/1", milestone: flags.milestone ?? null, verdict: "blocked",
        issues: [{ code: "unsupported_milestone", path: "milestone", message: "This checker requires --milestone M0", severity: "blocked" }] }
    } else {
      result = checkM0Milestone({
        manifestPath: inputPath("manifest"), attestationPath: inputPath("attestation"), goalPath: inputPath("goal"),
        costPolicyPath: inputPath("cost-policy"),
        artifactRoot: inputPath("artifact-root"), expectedRunId: flags["run-id"],
        expectedSourceRevision: context.environment.sourceRevision,
        sourceDirty: typeof context.environment.dirty === "boolean" ? context.environment.dirty : undefined,
        specPath, trustedVerifier,
        independentVerifierEstablished,
      })
    }
    exitCode = result.verdict === "passed" ? 0 : result.verdict === "failed" ? 1 : 2
  } catch {
    result = { schemaVersion: "m0-check-result/1", milestone: "M0", verdict: "blocked", executorError: true,
      issues: [{ code: "checker_error", path: "", message: "Checker could not safely inspect its inputs", severity: "blocked" }] }
    exitCode = 3
  }
  result = { ...result, ...(deployment ? { verifierDeployment: { ...deployment,
    verifier: deployment.verifier ? { id: deployment.verifier.id, keyId: deployment.verifier.keyId, binding: deployment.verifier.binding } : undefined,
    requestedScopeRegistered: independentVerifierEstablished } } : {}),
    startedAt: started.toISOString(), finishedAt: new Date().toISOString(), environment: context.environment, exitCode }
  try {
    mkdirSync(dirname(out), { recursive: true })
    mkdirSync(out, { mode: 0o700 })
    if (realpathSync(out) !== canonicalOut || !outputIsSeparate()) throw new Error("output path changed")
  } catch {
    console.error("blocked: output directory was created or aliased by another process; no report files were written")
    return 2
  }
  const files: Record<string, unknown> = {
    "result.json": result,
    "events.jsonl": [...(result.issues ?? []).map((issue: unknown) => JSON.stringify({ type: "milestone.check.issue", issue })),
      JSON.stringify({ type: "milestone.check.finished", verdict: result.verdict, exitCode })].join("\n") + "\n",
    "metrics.json": { durationMs: Date.now() - started.getTime(), checkedArtifacts: result.checkedArtifacts?.length ?? 0,
      requiredAcceptanceCount: result.requiredTests?.length ?? 15 },
    "human-interventions.json": [],
  }
  for (const [name, data] of Object.entries(files)) writeFileSync(join(out, name), typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  writeFileSync(join(out, "artifact-manifest.json"), JSON.stringify(Object.keys(files).map((name) => ({ path: name,
    digest: `sha256:${createHash("sha256").update(readFileSync(join(out, name))).digest("hex")}` })), null, 2) + "\n", { flag: "wx", mode: 0o600 })
  console.log(`M0 milestone: ${result.verdict}; signatureVerified=${result.signatureVerified ?? false}; ${result.issues?.length ?? 0} issue(s)\n${out}`)
  return exitCode
}
