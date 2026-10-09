import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { Effect, Schema } from "effect"
import { checkEvidenceBinding, checkFrozen, digestOf, parse, type ContextManifest, type GoalSpec } from "@loopit/contracts"
import { Digest, Id, PositiveInt, Ref, Timestamp } from "@loopit/contracts"
import type * as Delivery from "../service"
import type { DispatchRecord, Interface as DispatchInterface } from "./worker-dispatch"

/** Host-owned artifact index. It is not accepted from a model's output or log. */
export const RecoveryArtifactSchema = Schema.Struct({
  ref: Ref, path: Schema.String.check(Schema.isMinLength(1)), digest: Digest,
  role: Schema.Literals(["candidate", "evidence", "log", "experience", "source"]),
  taskId: Id, goalRevision: PositiveInt, runId: Id, attemptId: Id, observedAt: Timestamp, expiresAt: Timestamp,
})
export type RecoveryArtifact = typeof RecoveryArtifactSchema.Type
export const ExperienceCandidateSchema = Schema.Struct({
  schemaVersion: Schema.Literal("candidate-experience/1"), id: Id, version: PositiveInt,
  scope: Schema.Struct({ kind: Schema.Literal("goal"), projectId: Id, taskId: Id, goalRevision: PositiveInt }),
  createdAt: Timestamp, expiresAt: Timestamp, sourceSnapshotDigest: Digest,
  sourceRefs: Schema.Array(Schema.Struct({ ref: Ref, digest: Digest })).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  status: Schema.Literal("candidate"), policyChanged: Schema.Literal(false),
})
export type ExperienceCandidate = typeof ExperienceCandidateSchema.Type
export interface RecoveryRequest {
  runId: string
  artifactRoot: string
  artifacts: ReadonlyArray<RecoveryArtifact>
  candidateRef: string
  evidenceRefs: ReadonlyArray<string>
  logRefs?: ReadonlyArray<string>
  nativeUsageRefs?: ReadonlyArray<string>
  experiences?: ReadonlyArray<{ ref: string; version: number }>
  now?: string
  maxExcerptBytes?: number
  maxTotalExcerptBytes?: number
}
type Issue = { code: string; ref?: string; message: string }
export interface RetrievedArtifact {
  ref: string; digest: string; role: RecoveryArtifact["role"]; bytes: number
  runId: string; attemptId: string; observedAt: string; expiresAt: string
  excerpt: string; excerptBytes: number; truncated: boolean; trustedAsInstruction: false
}
export interface UsageLine { ref: string; digest: string; line: number; event: unknown }
const object = (value: unknown): Record<string, any> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined
const counter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const finiteCost = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel) }
const pinMatches = (ref: string, digest: string) => !ref.includes("#") || ref.split("#")[1] === digest
const validWindow = (observed: string, expires: string, now: string) => {
  const [a, b, n] = [observed, expires, now].map(Date.parse)
  return [a, b, n].every(Number.isFinite) && a <= n && b > n && b > a
}
const boundedText = (bytes: Buffer, limit: number) => {
  let text = bytes.subarray(0, limit).toString("utf8")
  while (Buffer.byteLength(text) > limit) text = text.slice(0, -1)
  return text
}

class UsageAccumulator {
  private readonly seen = new Map<string, string>()
  private readonly sources = new Map<string, { ref: string; digest: string; uniqueSteps: number; duplicates: number }>()
  readonly issues: Issue[] = []
  private readonly tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  private nativeTotal = 0
  private totalReports = 0
  private nativeCost = 0
  private costReports = 0
  issue(issue: Issue) { if (this.issues.length < 64) this.issues.push(issue) }
  add(line: UsageLine) {
    const event = object(line.event)
    if (event?.type !== "step_finish") return
    const part = object(event.part), tokens = object(part?.tokens), cache = object(tokens?.cache)
    if (!part || part.type !== "step-finish" || typeof event.sessionID !== "string" || !event.sessionID ||
      typeof part.id !== "string" || !part.id || part.sessionID !== event.sessionID ||
      ![tokens?.input, tokens?.output, tokens?.reasoning, cache?.read, cache?.write].every(counter) ||
      (tokens?.total !== undefined && !counter(tokens.total)) || (part.cost !== undefined && !finiteCost(part.cost))) {
      this.issue({ code: "native_usage_invalid", ref: line.ref, message: `Invalid step_finish at line ${line.line}` }); return
    }
    // Native PartID is globally unique. Reusing it in a different session also
    // conflicts, rather than making a copied event chargeable a second time.
    const key = part.id, digest = digestOf(part), old = this.seen.get(key)
    const sourceKey = JSON.stringify([line.ref, line.digest])
    if (!this.sources.has(sourceKey) && this.sources.size >= 64) { this.issue({ code: "native_usage_limit", message: "At most 64 native usage sources are inspected" }); return }
    const source = this.sources.get(sourceKey) ?? { ref: line.ref, digest: line.digest, uniqueSteps: 0, duplicates: 0 }
    this.sources.set(sourceKey, source)
    if (old) {
      if (old !== digest) this.issue({ code: "native_usage_conflict", ref: line.ref, message: `Conflicting repeated part ${part.id} at line ${line.line}` })
      else source.duplicates++
      return
    }
    if (this.seen.size >= 10_000) { this.issue({ code: "native_usage_limit", ref: line.ref, message: "At most 10000 distinct model steps are inspected" }); return }
    this.seen.set(key, digest); source.uniqueSteps++
    for (const field of ["input", "output", "reasoning"] as const) this.tokens[field] += tokens![field]
    for (const field of ["read", "write"] as const) this.tokens.cache[field] += cache![field]
    if (tokens!.total !== undefined) { this.nativeTotal += tokens!.total; this.totalReports++ }
    if (part.cost !== undefined) { this.nativeCost += part.cost; this.costReports++ }
    if (![this.tokens.input, this.tokens.output, this.tokens.reasoning, this.tokens.cache.read, this.tokens.cache.write, this.nativeTotal].every(counter) || !Number.isFinite(this.nativeCost))
      this.issue({ code: "native_usage_overflow", ref: line.ref, message: "Usage sum exceeded a safe numeric range" })
  }
  finish(upperLayerRunIds: ReadonlyArray<string>) {
    return { source: "opencode.step_finish" as const, status: this.issues.length ? "blocked" as const : this.seen.size ? "observed" as const : "unavailable" as const,
      modelSteps: this.seen.size, tokens: this.seen.size ? this.tokens : null,
      // Native total is reported separately; it is never added to token categories.
      nativeReportedTotal: this.totalReports ? { sum: this.nativeTotal, reportingSteps: this.totalReports } : null,
      nativeReportedCostUsd: this.costReports ? { sum: this.nativeCost, reportingSteps: this.costReports, billingVerified: false as const } : null,
      cost: { known: false as const, reason: "Native CLI cost is not independently verified billing; missing or zero cost does not establish free usage" },
      retries: { upperLayer: { count: Math.max(0, upperLayerRunIds.length - 1), runIds: [...upperLayerRunIds], source: "persisted Run.priorRunId" },
        providerInternal: { known: false as const, reason: "step_finish counts model steps, not provider retry attempts" } },
      provenance: [...this.sources.values()], issues: this.issues }
  }
}
/** Pure parsing helper. Recovery below additionally verifies source file bytes.
 * Callers of this standalone helper must independently establish the provenance. */
export function aggregateNativeUsage(lines: Iterable<UsageLine>, upperLayerRunIds: ReadonlyArray<string>) {
  const usage = new UsageAccumulator()
  for (const line of lines) usage.add(line)
  return usage.finish(upperLayerRunIds)
}

function inspectFile(path: string, excerptLimit: number, json: boolean, onLine?: (line: number, bytes?: Buffer) => void) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > 1024 ** 3) throw new Error("Artifact must be a regular file at most 1 GiB")
    const captureLimit = json ? 8 * 1024 * 1024 : excerptLimit
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024), captured: Buffer[] = []
    let size = 0, capturedBytes = 0, pending = Buffer.alloc(0), oversizedLine = false, line = 0
    const emit = () => { onLine?.(++line, oversizedLine ? undefined : pending); pending = Buffer.alloc(0); oversizedLine = false }
    let read: number
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      size += read
      if (size > 1024 ** 3) throw new Error("Artifact exceeds 1 GiB")
      const chunk = buffer.subarray(0, read); hash.update(chunk)
      if (capturedBytes < captureLimit) { const part = Buffer.from(chunk.subarray(0, captureLimit - capturedBytes)); captured.push(part); capturedBytes += part.length }
      if (onLine) {
        let offset = 0
        for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, offset)) {
          const part = chunk.subarray(offset, end)
          if (!oversizedLine && pending.length + part.length <= 1024 * 1024) pending = Buffer.concat([pending, part])
          else oversizedLine = true
          emit(); offset = end + 1
        }
        const rest = chunk.subarray(offset)
        if (!oversizedLine && pending.length + rest.length <= 1024 * 1024) pending = Buffer.concat([pending, rest])
        else oversizedLine = true
      }
    }
    if (onLine && (pending.length || oversizedLine)) emit()
    const after = fstatSync(fd), current = statSync(path)
    if (after.size !== size || before.size !== size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.ino !== after.ino || current.dev !== after.dev)
      throw new Error("Artifact changed while reading")
    if (json && size > captureLimit) throw new Error("Structured artifact exceeds 8 MiB")
    return { digest: `sha256:${hash.digest("hex")}`, size, captured: Buffer.concat(captured) }
  } finally { closeSync(fd) }
}

export interface RecoveredSnapshot {
  schemaVersion: "recovered-context/1"
  recoveredAt: string
  goal: GoalSpec
  goalDigest: string
  runId: string
  dispatchDigest: string
  baseContext: ContextManifest
  candidate: { ref: string; digest: string }
  artifacts: RetrievedArtifact[]
  experienceRetrievals: Array<{ ref: string; digest: string; version: number; retrievedAt: string; candidate: ExperienceCandidate; applied: false }>
  usage: ReturnType<UsageAccumulator["finish"]>
  nativeSessionUsed: false
  resumeAuthorized: false
  policyChanged: false
  gate: "not_evaluated"
}
export type RecoveryResult = { status: "ready"; snapshot: RecoveredSnapshot; digest: string; issues: [] } |
  { status: "blocked"; issues: Issue[]; snapshot?: never; digest?: never }
const contextBindingIssues = (goal: GoalSpec, record: DispatchRecord) => {
  const input = record.input
  return !input || !parse("context", input.context).ok || !parse("execution", input.spec).ok ||
    record.taskId !== goal.taskId || record.goalRevision !== goal.goalRevision || record.goalDigest !== digestOf(goal) ||
    input.context.goal.taskId !== goal.taskId || input.context.goal.goalRevision !== goal.goalRevision || input.context.goal.digest !== digestOf(goal) ||
    input.context.attemptId !== record.handle.attemptId || input.spec.attemptId !== record.handle.attemptId ||
    input.spec.contextManifest.digest !== digestOf(input.context) || input.spec.policyRef !== goal.policyRef ||
    `${input.context.policy.ref}#${input.context.policy.digest}` !== goal.policyRef ||
    !input.context.effectiveConfig.some((entry) => entry.kind === "instruction" && entry.digest === digestOf(input.prompt))
}

/** Reads persisted projections; produces explanatory context only. It neither
 * releases Runtime reservations nor authorizes/resumes any execution. */
export const recoverRunContext = (services: { delivery: Pick<Delivery.Interface, "getTask" | "getRun">; dispatch: Pick<DispatchInterface, "get"> }, request: RecoveryRequest): Effect.Effect<RecoveryResult> => Effect.gen(function* () {
  const issues: Issue[] = [], now = request.now ?? new Date().toISOString()
  const add = (code: string, message: string, ref?: string) => issues.push({ code, message, ...(ref ? { ref } : {}) })
  const run = yield* services.delivery.getRun(request.runId)
  const record = yield* services.dispatch.get(request.runId)
  const task = run ? yield* services.delivery.getTask(run.taskId) : undefined
  const revision = run && task?.revisions[run.goalRevision]
  const goal = revision?.goal
  if (!run || !record || !task || !revision?.frozen || !goal || !parse("goal", goal).ok || checkFrozen(goal).length ||
    task.currentRevision !== run.goalRevision || record.runId !== request.runId || revision.goalDigest !== digestOf(goal) || contextBindingIssues(goal, record))
    return { status: "blocked", issues: [{ code: "persisted_context_mismatch", message: "Current frozen goal, Run and persisted DispatchRecord input must agree" }] } as RecoveryResult
  const perFile = request.maxExcerptBytes ?? 4096, totalLimit = request.maxTotalExcerptBytes ?? 32768
  if (!Number.isFinite(Date.parse(now)) || !Number.isSafeInteger(perFile) || perFile < 0 || perFile > 65536 ||
    !Number.isSafeInteger(totalLimit) || totalLimit < 0 || totalLimit > 262144 || request.artifacts.length > 64 || !request.evidenceRefs.length ||
    [request.evidenceRefs, request.logRefs, request.nativeUsageRefs, request.experiences].some((refs) => refs && refs.length > 64))
    return { status: "blocked", issues: [{ code: "invalid_recovery_request", message: "Time, evidence references or bounded recovery limits are invalid" }] } as RecoveryResult
  const runIds = [run.runId], seenRuns = new Set(runIds)
  let previous = run.priorRunId
  while (previous) {
    if (seenRuns.has(previous) || runIds.length >= 128) { add("retry_lineage_invalid", "Retry lineage contains a cycle or exceeds 128 Runs"); break }
    const prior = yield* services.delivery.getRun(previous)
    if (!prior || prior.taskId !== goal.taskId || prior.goalRevision !== goal.goalRevision) { add("retry_lineage_invalid", "Retry predecessor is missing or belongs to another goal"); break }
    seenRuns.add(previous); runIds.push(previous); previous = prior.priorRunId
  }
  const index = new Map<string, RecoveryArtifact>()
  for (const raw of request.artifacts) {
    let artifact: RecoveryArtifact
    try { artifact = Schema.decodeUnknownSync(RecoveryArtifactSchema)(raw, { onExcessProperty: "error" }) }
    catch { add("artifact_index_invalid", "Host artifact index contains invalid metadata"); continue }
    if (index.has(artifact.ref)) { add("artifact_ref_duplicate", "Artifact reference is repeated", artifact.ref); continue }
    index.set(artifact.ref, artifact)
    const origin = artifact.runId === run.runId ? run : yield* services.delivery.getRun(artifact.runId)
    const dispatched = artifact.runId === run.runId ? record : yield* services.dispatch.get(artifact.runId)
    if (!origin || !dispatched || origin.taskId !== goal.taskId || origin.goalRevision !== goal.goalRevision ||
      artifact.taskId !== goal.taskId || artifact.goalRevision !== goal.goalRevision || artifact.attemptId !== dispatched.handle.attemptId ||
      dispatched.runId !== artifact.runId || contextBindingIssues(goal, dispatched)) add("artifact_binding_mismatch", "Artifact is not bound to a persisted Run/Attempt of this goal", artifact.ref)
  }
  let root: string
  try { root = realpathSync(request.artifactRoot); if (!statSync(root).isDirectory()) throw new Error("not a directory") }
  catch { return { status: "blocked", issues: [...issues, { code: "artifact_root_invalid", message: "Trusted artifact root is unavailable" }] } as RecoveryResult }
  const retrieved = new Map<string, RetrievedArtifact>(), contents = new Map<string, Buffer>(), usage = new UsageAccumulator()
  const usageRefs = new Set(request.nativeUsageRefs ?? [])
  let excerptRemaining = totalLimit
  const load = (ref: string, roles: RecoveryArtifact["role"][]): RetrievedArtifact | undefined => {
    const artifact = index.get(ref)
    if (!artifact || !roles.includes(artifact.role)) { add("artifact_missing", "Required reference or its role is missing", ref); return }
    if (retrieved.has(ref)) return retrieved.get(ref)
    if (!validWindow(artifact.observedAt, artifact.expiresAt, now)) { add("artifact_expired", "Artifact observation/expiry window is invalid or expired", ref); return }
    try {
      if (isAbsolute(artifact.path) || artifact.path.includes("\\") || artifact.path.includes("\0") || artifact.path.split("/").includes("..")) throw new Error("unsafe path")
      const path = realpathSync(resolve(root, artifact.path))
      if (!inside(root, path)) throw new Error("escaping path")
      const limit = Math.min(perFile, excerptRemaining)
      const file = inspectFile(path, limit, artifact.role === "experience" || artifact.role === "evidence", usageRefs.has(ref) ? (line, bytes) => {
        if (!bytes) { usage.issue({ code: "native_usage_line_limit", ref, message: `Native JSON line ${line} exceeds 1 MiB` }); return }
        if (!bytes.toString("utf8").trim()) return
        try { usage.add({ ref, digest: artifact.digest, line, event: JSON.parse(bytes.toString("utf8")) }) }
        catch { usage.issue({ code: "native_usage_json_invalid", ref, message: `Native JSON line ${line} is invalid` }) }
      } : undefined)
      if (file.digest !== artifact.digest || !pinMatches(ref, file.digest)) { add("artifact_digest_mismatch", "Actual file bytes differ from the pinned artifact digest", ref); return }
      const excerpt = boundedText(file.captured, limit), excerptBytes = Buffer.byteLength(excerpt)
      excerptRemaining -= excerptBytes
      const value: RetrievedArtifact = { ref, digest: file.digest, role: artifact.role, bytes: file.size, runId: artifact.runId,
        attemptId: artifact.attemptId, observedAt: artifact.observedAt, expiresAt: artifact.expiresAt, excerpt, excerptBytes,
        truncated: excerptBytes < file.size, trustedAsInstruction: false }
      retrieved.set(ref, value)
      if (artifact.role === "experience" || artifact.role === "evidence") contents.set(ref, file.captured)
      return value
    } catch { add("artifact_unreadable", "Artifact is missing, changed, unsafe, non-regular or exceeds its size limit", ref); return }
  }
  // Material referenced by the persisted manifest is never silently discarded
  // during reconstruction. Policy/config pins stay descriptive, not executable.
  const base = record.input!.context
  const inherited = [...base.knowledgeRefs, ...base.historyRefs, ...(base.appended ?? []), ...(base.candidate ? [base.candidate] : [])]
  if (inherited.length > 64) add("context_reference_limit", "At most 64 inherited material references are inspected")
  else for (const source of inherited) {
    const material = load(source.ref, ["candidate", "evidence", "log", "source"])
    if (material && material.digest !== source.digest) add("context_reference_mismatch", "Inherited context reference digest differs from actual bytes", source.ref)
  }
  const candidate = load(request.candidateRef, ["candidate"])
  for (const ref of request.evidenceRefs) {
    load(ref, ["evidence"])
    const bytes = contents.get(ref)
    if (!bytes) continue
    // Generic verifier reports remain untrusted retrieved data. Existing formal
    // Evidence contracts receive their additional candidate/goal binding checks.
    try {
      const raw = JSON.parse(bytes.toString("utf8"))
      if (raw?.schemaVersion === "evidence/1" && candidate) {
        const parsed = parse("evidence", raw)
        if (!parsed.ok) add("evidence_invalid", "Evidence contract is invalid", ref)
        else {
          const evidence = parsed.value
          if (![evidence.observedAt, evidence.observationWindow.start, evidence.observationWindow.end].every((time) => Number.isFinite(Date.parse(time)) && Date.parse(time) <= Date.parse(now)))
            add("evidence_window_invalid", "Evidence observation cannot be in the future", ref)
          for (const issue of checkEvidenceBinding(evidence, { goal, acceptanceDigest: digestOf(goal.acceptance), candidateDigest: candidate.digest, now }))
            add(issue.code, issue.message, ref)
        }
      }
    } catch { /* Plain-text evidence is a retrieved observation, never a formal Gate. */ }
  }
  for (const ref of new Set([...(request.logRefs ?? []), ...(request.nativeUsageRefs ?? [])])) load(ref, ["log"])
  const experienceRetrievals: RecoveredSnapshot["experienceRetrievals"] = []
  for (const wanted of request.experiences ?? []) {
    const file = load(wanted.ref, ["experience"])
    if (!file) continue
    try {
      const experience = Schema.decodeUnknownSync(ExperienceCandidateSchema)(JSON.parse(contents.get(wanted.ref)!.toString("utf8")), { onExcessProperty: "error" })
      if (experience.version !== wanted.version || experience.scope.projectId !== goal.projectId || experience.scope.taskId !== goal.taskId ||
        experience.scope.goalRevision !== goal.goalRevision || !validWindow(experience.createdAt, experience.expiresAt, now)) throw new Error("experience scope/version/time mismatch")
      for (const source of experience.sourceRefs) {
        if (source.ref === wanted.ref) throw new Error("self source")
        const artifact = load(source.ref, ["candidate", "evidence", "log", "source"])
        if (!artifact || artifact.digest !== source.digest) throw new Error("experience source mismatch")
      }
      experienceRetrievals.push({ ref: wanted.ref, digest: file.digest, version: experience.version, retrievedAt: now, candidate: experience, applied: false })
    } catch { add("experience_invalid", "Candidate experience has stale, mismatched or untraceable scope/version/sources", wanted.ref) }
  }
  issues.push(...usage.issues)
  if (!candidate || issues.length) return { status: "blocked", issues } as RecoveryResult
  const snapshot: RecoveredSnapshot = { schemaVersion: "recovered-context/1", recoveredAt: now, goal, goalDigest: digestOf(goal), runId: request.runId,
    dispatchDigest: digestOf(record), baseContext: structuredClone(record.input!.context), candidate: { ref: candidate.ref, digest: candidate.digest },
    artifacts: [...retrieved.values()], experienceRetrievals, usage: usage.finish(runIds),
    nativeSessionUsed: false, resumeAuthorized: false, policyChanged: false, gate: "not_evaluated" }
  return { status: "ready", snapshot, digest: digestOf(snapshot), issues: [] } as RecoveryResult
})

/** Returns a candidate artifact for the host to atomically archive. No policy or
 * knowledge index is modified; retrieval remains an explicit later operation. */
export function createExperienceCandidate(snapshot: RecoveredSnapshot, input: { id: string; version: number; summary: string; expiresAt: string }): ExperienceCandidate {
  const value = { schemaVersion: "candidate-experience/1", id: input.id, version: input.version,
    scope: { kind: "goal", projectId: snapshot.goal.projectId, taskId: snapshot.goal.taskId, goalRevision: snapshot.goal.goalRevision },
    createdAt: snapshot.recoveredAt, expiresAt: input.expiresAt, sourceSnapshotDigest: digestOf(snapshot),
    sourceRefs: snapshot.artifacts.filter((item) => item.role !== "experience").map(({ ref, digest }) => ({ ref, digest })),
    summary: input.summary, status: "candidate", policyChanged: false }
  if (!validWindow(value.createdAt, value.expiresAt, snapshot.recoveredAt)) throw new Error("Candidate experience expiry must be in the future")
  return Schema.decodeUnknownSync(ExperienceCandidateSchema)(value, { onExcessProperty: "error" })
}
