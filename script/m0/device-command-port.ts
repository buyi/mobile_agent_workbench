/** Host-only protocol seam. No executor, production admission, Runner loop,
 * subprocess, device mutation or autonomous positive configuration is shipped.
 * Trusted adapters belong in protected controller wiring, never request JSON. */
import { Effect } from "effect"
import { canonicalJson, digestOf } from "../../packages/contracts/src/digest"
import type * as Ledger from "../../packages/delivery/src/operation-ledger"
import type { AutonomousDeviceUse } from "./device-capabilities"
import { HostDeviceBindings, bytesDigest, exactDeviceObject, validDeviceDigest, validDeviceId, type DeviceBinding } from "./device-binding"
import { LocalDeviceBroker, type DeviceToken } from "./local-device-broker"

export type DeviceCommand = { kind: "inspect" | "boot" | "uninstall" | "shutdown" } | { kind: "install"; artifactDigest: string }
export interface DeviceCommandRequest {
  schemaVersion: "device-command/1"
  operationId: string; idempotencyKey: string
  taskId: string; runId: string; goalRevision: number; goalDigest: string
  resourceId: string; bindingDigest: string
  command: DeviceCommand
  requestDigest: string
}
/** Returned by a host adapter reading an already accepted, persisted operation
 * and current Task/Run/Goal state. Do not implement this as echo(request). */
export interface AuthorizedDeviceOperation {
  operationId: string; idempotencyKey: string; requestDigest: string
  taskId: string; runId: string; goalRevision: number; goalDigest: string
  resourceId: string; bindingDigest: string
  ownerId: string; leaseId: string; generation: number; epoch: number
  deadlineAt: string; expiresAt: string
  mode: "dispatch" | "reconcile-only"
}
export interface HostOperationAuthority { current(operationId: string): AuthorizedDeviceOperation | undefined }
export interface DeviceArtifacts {
  /** Persist exact canonical request bytes durably, then return the byte pin. */
  putRequest(operationId: string, bytes: Uint8Array): Ledger.DurableRef
  read(ref: Ledger.DurableRef): Uint8Array
}
export interface DeviceExecutionInstruction {
  binding: DeviceBinding; bindingDigest: string
  lease: DeviceToken
  authorizationExpiresAt: string
  request: DeviceCommandRequest
  permit: Ledger.DispatchPermit
}
export interface TrustedDeviceExecutor {
  descriptor: { executorId: string; executorDigest: string; ownerUid: 422 }
  /** Future adapter must validate live fence/admission again at its actual OS
   * dispatch boundary and resolve install bytes by approved digest internally. */
  execute(instruction: DeviceExecutionInstruction): Promise<Ledger.DurableRef>
  /** Observe this existing operation only. Never call execute/install/retry. */
  query(instruction: DeviceExecutionInstruction): Promise<Ledger.DurableRef>
}
export interface DeviceObservation {
  schemaVersion: "device-observation/1"
  operationId: string; dispatchId: string; requestDigest: string; bindingDigest: string
  resourceId: string; ownerUid: 422; udid: string
  taskId: string; runId: string; goalRevision: number; goalDigest: string
  ownerId: string; generation: number; epoch: number
  outcome: "succeeded" | "failed"; observedAt: string
  deviceState: "Booted" | "Shutdown"
  appPresent: boolean; appArtifactDigest: string | null
}

const requestKeys = ["schemaVersion", "operationId", "idempotencyKey", "taskId", "runId", "goalRevision", "goalDigest", "resourceId", "bindingDigest", "command", "requestDigest"]
const operationKeys = ["operationId", "idempotencyKey", "requestDigest", "taskId", "runId", "goalRevision", "goalDigest", "resourceId", "bindingDigest", "ownerId", "leaseId", "generation", "epoch", "deadlineAt", "expiresAt", "mode"]
const observationKeys = ["schemaVersion", "operationId", "dispatchId", "requestDigest", "bindingDigest", "resourceId", "ownerUid", "udid", "taskId", "runId", "goalRevision", "goalDigest", "ownerId", "generation", "epoch", "outcome", "observedAt", "deviceState", "appPresent", "appArtifactDigest"]
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const fenceFor = (token: DeviceToken): Ledger.Fence => ({ ownerId: token.ownerId, generation: token.generation, epoch: token.epoch })
const payloadOf = (request: DeviceCommandRequest) => { const { requestDigest: _, ...payload } = request; return payload }
const useFor = (request: DeviceCommandRequest): AutonomousDeviceUse => ({ purpose: "autonomous", taskId: request.taskId, runId: request.runId,
  goalRevision: request.goalRevision, goalDigest: request.goalDigest })

export function parseDeviceCommandRequest(input: unknown): DeviceCommandRequest {
  exactDeviceObject(input, requestKeys)
  exactDeviceObject(input.command, input.command?.kind === "install" ? ["kind", "artifactDigest"] : ["kind"])
  if (input.schemaVersion !== "device-command/1" || !["operationId", "idempotencyKey", "taskId", "runId", "resourceId"].every((key) => validDeviceId(input[key])) ||
      !Number.isSafeInteger(input.goalRevision) || input.goalRevision < 1 || ![input.goalDigest, input.bindingDigest, input.requestDigest].every(validDeviceDigest) ||
      !["inspect", "boot", "install", "uninstall", "shutdown"].includes(input.command.kind) ||
      (input.command.kind === "install" && !validDeviceDigest(input.command.artifactDigest))) throw new Error("invalid_device_command_request")
  const request = structuredClone(input) as DeviceCommandRequest
  if (digestOf(payloadOf(request)) !== request.requestDigest) throw new Error("device_request_digest_mismatch")
  return request
}

export class TypedDeviceCommandPort {
  readonly #token: DeviceToken
  constructor(private readonly host: {
    broker: LocalDeviceBroker; token: DeviceToken; bindings: HostDeviceBindings
    ledger: Ledger.Interface; authority: HostOperationAuthority; artifacts: DeviceArtifacts
    executor?: TrustedDeviceExecutor
  }) { this.#token = structuredClone(host.token) }

  private authorized(request: DeviceCommandRequest, reconcile = false) {
    const token = this.#token, { binding, bindingDigest } = this.host.bindings.get(token.resourceId)
    if (request.resourceId !== token.resourceId || request.bindingDigest !== bindingDigest) throw new Error("device_request_binding_mismatch")
    const authority = this.host.authority.current(request.operationId)
    exactDeviceObject(authority, operationKeys)
    const expected = { operationId: request.operationId, idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest,
      taskId: request.taskId, runId: request.runId, goalRevision: request.goalRevision, goalDigest: request.goalDigest,
      resourceId: token.resourceId, bindingDigest, ownerId: token.ownerId, leaseId: token.leaseId, generation: token.generation, epoch: token.epoch, deadlineAt: token.deadlineAt }
    if (Object.entries(expected).some(([key, value]) => authority[key as keyof AuthorizedDeviceOperation] !== value) || !["dispatch", "reconcile-only"].includes(authority.mode) ||
        (!reconcile && authority.mode !== "dispatch") || !timestamp(authority.expiresAt) || Date.parse(authority.expiresAt) <= Date.now() ||
        !timestamp(authority.deadlineAt) || (!reconcile && (Date.parse(authority.deadlineAt) <= Date.now() || Date.parse(authority.expiresAt) > Date.parse(authority.deadlineAt))))
      throw new Error("device_operation_not_authorized")
    const use = useFor(request)
    // Default registry deliberately rejects here. This class cannot turn a
    // probe lease, request flag, callback name or binding into OS authority.
    if (reconcile) this.host.broker.assertReconciliation(token, request.operationId, use)
    else this.host.broker.assertAdmission(token, use)
    const admission = token.admission
    if (!admission || admission.purpose !== "autonomous" || admission.bindingDigest !== bindingDigest || admission.capabilityDigest !== binding.capabilityDigest ||
        digestOf({ purpose: admission.purpose, taskId: admission.taskId, runId: admission.runId, goalRevision: admission.goalRevision, goalDigest: admission.goalDigest }) !== digestOf(use))
      throw new Error("autonomous_device_admission_binding_required")
    const executor = this.host.executor
    if (!executor || typeof executor.execute !== "function" || typeof executor.query !== "function") throw new Error("trusted_device_executor_unavailable")
    exactDeviceObject(executor.descriptor, ["executorId", "executorDigest", "ownerUid"])
    if (executor.descriptor.executorId !== binding.executorId || executor.descriptor.executorDigest !== binding.executorDigest || executor.descriptor.ownerUid !== 422)
      throw new Error("trusted_device_executor_binding_mismatch")
    return { binding, bindingDigest, use, executor, authorizationExpiresAt: authority.expiresAt }
  }

  private checkedBytes(ref: Ledger.DurableRef, maximum: number) {
    exactDeviceObject(ref, ["ref", "digest"])
    if (typeof ref.ref !== "string" || !/^artifact:\/\/[^\s#]+$/.test(ref.ref) || !validDeviceDigest(ref.digest)) throw new Error("invalid_device_artifact_ref")
    const bytes = this.host.artifacts.read(ref)
    if (!(bytes instanceof Uint8Array) || bytes.length > maximum || bytesDigest(bytes) !== ref.digest) throw new Error("device_artifact_bytes_mismatch")
    return bytes
  }

  private checkedEntry(request: DeviceCommandRequest, entry: Ledger.Entry | undefined) {
    const token = this.#token
    if (!entry || entry.scopeId !== token.resourceId || entry.ownerId !== token.ownerId || entry.record.operationId !== request.operationId ||
        entry.record.requestDigest !== request.requestDigest || entry.record.idempotencyKey !== request.idempotencyKey ||
        entry.record.ownerGeneration !== token.generation || entry.record.recoveryEpoch !== token.epoch || !entry.dispatchId || !entry.journal ||
        digestOf(entry.journal.intent) !== entry.journal.durable.digest || !timestamp(entry.history[0]?.at)) throw new Error("device_operation_ledger_binding_mismatch")
    const intent = entry.journal.intent
    if (intent.scopeId !== token.resourceId || intent.operationId !== request.operationId || intent.requestDigest !== request.requestDigest ||
        intent.idempotencyKey !== request.idempotencyKey || intent.dispatchId !== entry.dispatchId || digestOf(intent.fence) !== digestOf(fenceFor(token)) ||
        digestOf(intent.requestRef) !== digestOf(entry.requestRef)) throw new Error("device_operation_journal_binding_mismatch")
    const bytes = this.checkedBytes(entry.requestRef, 16_384)
    if (bytesDigest(bytes) !== request.requestDigest || Buffer.from(bytes).toString("utf8") !== canonicalJson(payloadOf(request))) throw new Error("device_operation_request_bytes_mismatch")
    return entry as Ledger.Entry & { dispatchId: string; journal: Ledger.JournalAck }
  }

  private observation(ref: Ledger.DurableRef, request: DeviceCommandRequest, entry: Ledger.Entry & { dispatchId: string }) {
    const value = JSON.parse(Buffer.from(this.checkedBytes(ref, 256 * 1024)).toString("utf8"))
    exactDeviceObject(value, observationKeys)
    const { binding } = this.host.bindings.get(this.#token.resourceId)
    const expected = { schemaVersion: "device-observation/1", operationId: request.operationId, dispatchId: entry.dispatchId,
      requestDigest: request.requestDigest, bindingDigest: request.bindingDigest, resourceId: request.resourceId, ownerUid: 422, udid: binding.udid,
      taskId: request.taskId, runId: request.runId, goalRevision: request.goalRevision, goalDigest: request.goalDigest, ...fenceFor(this.#token) }
    if (Object.entries(expected).some(([key, data]) => value[key] !== data) || !["succeeded", "failed"].includes(value.outcome) ||
        !timestamp(value.observedAt) || Date.parse(value.observedAt) < Date.parse(entry.history[0]?.at ?? "invalid") || Date.parse(value.observedAt) > Date.now() ||
        !["Booted", "Shutdown"].includes(value.deviceState) || typeof value.appPresent !== "boolean" ||
        (value.appPresent ? !validDeviceDigest(value.appArtifactDigest) : value.appArtifactDigest !== null)) throw new Error("device_observation_binding_mismatch")
    if (value.outcome === "succeeded" && ((request.command.kind === "install" && (!value.appPresent || value.appArtifactDigest !== request.command.artifactDigest)) ||
        (request.command.kind === "uninstall" && value.appPresent) || (request.command.kind === "boot" && value.deviceState !== "Booted") ||
        (request.command.kind === "shutdown" && value.deviceState !== "Shutdown"))) throw new Error("device_observation_does_not_prove_command")
    return value as DeviceObservation
  }

  async execute(input: unknown) {
    const request = parseDeviceCommandRequest(input), token = this.#token, fence = fenceFor(token)
    this.authorized(request)
    const bytes = Buffer.from(canonicalJson(payloadOf(request)))
    const requestRef = this.host.artifacts.putRequest(request.operationId, bytes)
    if (requestRef.digest !== request.requestDigest || Buffer.from(this.checkedBytes(requestRef, 16_384)).compare(bytes) !== 0) throw new Error("device_request_not_durably_pinned")
    const run = Effect.runPromise
    await run(this.host.ledger.activate(token.resourceId, fence))
    await run(this.host.ledger.recordIntent({ scopeId: token.resourceId, ownerId: token.ownerId, requestRef,
      record: { schemaVersion: "operation/1", operationId: request.operationId, idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest,
        sideEffect: "reconcile_required", ownerGeneration: token.generation, recoveryEpoch: token.epoch, state: "intent_recorded",
        reconcileMethod: "provider-query", lastObservedAt: new Date().toISOString() } }))
    // No SQL transaction contains an await or a provider call.
    this.authorized(request)
    this.host.broker.begin(token, request.operationId, request.command.kind === "inspect" ? "observe" : "mutate", useFor(request))
    try {
      const permit = await run(this.host.ledger.prepareDispatch(request.operationId, fence))
      const entry = this.checkedEntry(request, await run(this.host.ledger.get(request.operationId)))
      if (entry.phase !== "permitted" || digestOf(permit.journal) !== digestOf(entry.journal) || digestOf(permit.intent) !== digestOf(entry.journal.intent))
        throw new Error("device_dispatch_permit_mismatch")
      const current = this.authorized(request)
      this.host.broker.assertCommand(token, request.operationId, current.use)
      const evidence = await current.executor.execute(structuredClone({ binding: current.binding, bindingDigest: current.bindingDigest,
        lease: token, authorizationExpiresAt: current.authorizationExpiresAt, request, permit }))
      const observation = this.observation(evidence, request, entry)
      await run(this.host.ledger.recordReceipt(request.operationId, fence, { state: observation.outcome, evidence,
        externalResourceRef: `simulator://${current.binding.udid}/app/${current.binding.bundleId}` }))
      this.host.broker.finish(token, request.operationId, observation.outcome === "succeeded" ? "completed" : "failed", evidence)
      return { operationId: request.operationId, outcome: observation.outcome, evidence, bindingDigest: request.bindingDigest }
    } catch (error) {
      // If either store already settled, its transition guard preserves that
      // fact; the other remains conservative. Nothing grants another dispatch.
      try { this.host.broker.finish(token, request.operationId, "unknown") } catch {}
      try { await run(this.host.ledger.markIndeterminate(request.operationId, fence)) } catch {}
      throw error
    }
  }

  async query(input: unknown) {
    const request = parseDeviceCommandRequest(input), token = this.#token, fence = fenceFor(token), run = Effect.runPromise
    this.authorized(request, true)
    // A reopened host must check the journal's current authority before even
    // querying. This does not reserve a second dispatch or retry the command.
    await run(this.host.ledger.activate(token.resourceId, fence))
    const entry = this.checkedEntry(request, await run(this.host.ledger.get(request.operationId)))
    if (entry.record.state !== "indeterminate" || entry.phase !== "indeterminate") throw new Error("device_query_requires_existing_unknown_operation")
    const current = this.authorized(request, true)
    const evidence = await current.executor.query(structuredClone({ binding: current.binding, bindingDigest: current.bindingDigest,
      lease: token, authorizationExpiresAt: current.authorizationExpiresAt, request,
      permit: { intent: entry.journal.intent, journal: entry.journal } }))
    const observation = this.observation(evidence, request, entry)
    this.authorized(request, true)
    await run(this.host.ledger.reconcile(request.operationId, fence, { state: observation.outcome, evidence,
      externalResourceRef: `simulator://${current.binding.udid}/app/${current.binding.bundleId}` }))
    this.host.broker.finishReconciliation(token, request.operationId, observation.outcome === "succeeded" ? "completed" : "failed", evidence, current.use)
    return { operationId: request.operationId, outcome: observation.outcome, evidence, resourceRemainsQuarantined: true as const }
  }
}
