/** Finite experiment logic. Provider callbacks are trusted host ports, never
 * model arguments. Fixture callbacks do not establish any OS device property. */
import { Effect } from "effect"
import { digestOf } from "../../packages/contracts/src/digest"
import type * as Ledger from "../../packages/delivery/src/operation-ledger"
import { LocalDeviceBroker, type DeviceToken } from "./local-device-broker"
import type { OperatorProbeUse } from "./device-capabilities"

export interface InstallObservation { matched: boolean; artifactDigest: string; observedDigest: string; evidence: Ledger.DurableRef; externalResourceRef: string }
export async function exerciseIosBrokerProtocol(options: {
  broker: LocalDeviceBroker; token: DeviceToken; probe: OperatorProbeUse; ledger: Ledger.Interface; artifactDigest: string
  save: (name: string, value: unknown) => Ledger.DurableRef
  install: () => Promise<void>
  unavailableQuery: () => Promise<never>
  query: () => Promise<InstallObservation>
  cleanup: () => Promise<Ledger.DurableRef>
}) {
  const { broker, token, ledger, probe } = options
  broker.assertAdmission(token, probe)
  const fence = { ownerId: token.ownerId, generation: token.generation, epoch: token.epoch }
  const checks: Record<string, unknown> = {}, operationId = `install-${token.leaseId}`
  const request = { deviceId: token.resourceId, artifactDigest: options.artifactDigest, action: "install" }
  const requestRef = options.save("install-request.json", request), run = Effect.runPromise
  const rejected = async (name: string, call: () => unknown | Promise<unknown>, expected: string) => {
    try { await call() } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes(expected)) throw error
      checks[name] = { rejected: true, reason: expected }; return
    }
    throw new Error(`Expected rejection missing: ${name}`)
  }
  await run(ledger.activate(token.resourceId, fence))
  await rejected("competingOwner", () => broker.acquire(token.resourceId, "competing-owner", token.deadlineAt, probe), "device_lease_unavailable")
  await rejected("staleBrokerFence", () => broker.begin({ ...token, generation: token.generation - 1 }, "stale-broker-command", "mutate", probe), "stale_device_fence")
  await rejected("staleLedgerFence", () => run(ledger.activate(token.resourceId, { ...fence, generation: fence.generation - 1 })), "stale_fence")
  await run(ledger.recordIntent({ scopeId: token.resourceId, ownerId: token.ownerId, requestRef,
    record: { schemaVersion: "operation/1", operationId, idempotencyKey: `install:${token.resourceId}:${options.artifactDigest}`,
      requestDigest: requestRef.digest, sideEffect: "reconcile_required", ownerGeneration: fence.generation, recoveryEpoch: fence.epoch,
      state: "intent_recorded", reconcileMethod: "provider-query", lastObservedAt: new Date().toISOString() } }))
  await run(ledger.prepareDispatch(operationId, fence))
  broker.begin(token, operationId, "mutate", probe)
  broker.assertCommand(token, operationId, probe)
  try { await options.install() }
  catch (error) {
    broker.finish(token, operationId, "unknown")
    await run(ledger.markIndeterminate(operationId, fence))
    throw error
  }
  // The provider completed, but deliberately omit its ledger receipt. This is
  // fault injection at the receipt boundary, not an actual OS crash claim.
  broker.finish(token, operationId, "completed")
  await run(ledger.markIndeterminate(operationId, fence))
  checks.installReceiptLost = { operationId, injected: true, providerCompleted: true, ledgerState: (await run(ledger.get(operationId)))!.record.state }
  await rejected("unknownInstallCannotRedispatch", () => run(ledger.prepareDispatch(operationId, fence)), "dispatch_requires_reconciliation")
  // Inject query unavailability before the provider port. Do not call install
  // again or reinterpret a missing observation as a negative observation.
  await rejected("queryPortUnavailable", options.unavailableQuery, "query_unavailable_fault_before_provider")
  checks.queryUnavailable = { injected: true, providerDispatched: false, ledgerState: (await run(ledger.get(operationId)))!.record.state, installRepeated: false }
  options.save("query-unavailable.json", checks.queryUnavailable)
  await rejected("queryUnavailableCannotRedispatch", () => run(ledger.prepareDispatch(operationId, fence)), "dispatch_requires_reconciliation")
  await rejected("renamedInstallCannotBypassUnknown", () => run(ledger.recordIntent({ scopeId: token.resourceId, ownerId: token.ownerId, requestRef,
    record: { schemaVersion: "operation/1", operationId: `renamed-${token.leaseId}`, idempotencyKey: `install:${token.resourceId}:${options.artifactDigest}`,
      requestDigest: requestRef.digest, sideEffect: "reconcile_required", ownerGeneration: fence.generation, recoveryEpoch: fence.epoch,
      state: "intent_recorded", reconcileMethod: "provider-query", lastObservedAt: new Date().toISOString() } })), "idempotency_key_reused")
  const queryId = `query-${token.leaseId}`
  broker.begin(token, queryId, "observe", probe)
  broker.assertCommand(token, queryId, probe)
  let observation: InstallObservation
  try { observation = await options.query(); broker.finish(token, queryId, "completed", observation.evidence) }
  catch (error) { broker.finish(token, queryId, "unknown"); throw error }
  if (!observation.matched || observation.artifactDigest !== options.artifactDigest || observation.observedDigest !== options.artifactDigest) {
    broker.quarantine(token, "installed_artifact_mismatch")
    throw new Error("Installed bytes did not match the frozen app; no success receipt recorded")
  }
  const settled = await run(ledger.reconcile(operationId, fence, { state: "succeeded", evidence: observation.evidence, externalResourceRef: observation.externalResourceRef }))
  checks.actualInstallQuery = { operationId: settled.record.operationId, state: settled.record.state, evidence: observation.evidence, artifactDigest: observation.artifactDigest }

  const faultId = `cleanup-fault-${token.leaseId}`
  broker.begin(token, faultId, "cleanup", probe)
  broker.finish(token, faultId, "failed", options.save("cleanup-fault.json", { injected: true, providerDispatched: false, error: "cleanup_fault_before_provider" }))
  checks.cleanupFailure = { injected: true, providerDispatched: false, quarantined: broker.get(token.resourceId)?.status === "quarantined" }
  await rejected("cleanupQuarantineBlocksOwner", () => broker.acquire(token.resourceId, "next-owner", token.deadlineAt, probe), "device_lease_unavailable")
  await rejected("cleanupQuarantineBlocksMutation", () => broker.begin(token, `forbidden-${token.leaseId}`, "mutate", probe), "device_quarantined_or_released")
  const cleanupId = `cleanup-${token.leaseId}`
  broker.begin(token, cleanupId, "cleanup", probe)
  broker.assertCommand(token, cleanupId, probe)
  let cleanupProof: Ledger.DurableRef
  try { cleanupProof = await options.cleanup(); broker.finish(token, cleanupId, "completed", cleanupProof) }
  catch (error) { broker.finish(token, cleanupId, "unknown"); throw error }
  broker.releaseAfterCleanup(token, cleanupProof)
  const next = broker.acquire(token.resourceId, "fence-negative-owner", token.deadlineAt, probe)
  await rejected("retiredTokenCannotControlNewLease", () => broker.begin(token, `retired-${token.leaseId}`, "observe", probe), "stale_device_fence")
  // No provider command was made under `next`; the trusted host's just-observed
  // cleanup still applies. This is protocol release, not an OS exclusion proof.
  broker.releaseAfterCleanup(next, cleanupProof)
  return { checks, operation: await run(ledger.get(operationId)), cleanupProof, historyDigest: digestOf(broker.history(token.resourceId)),
    osExclusiveControl: false, independentFailureDomain: false, fullM0A08Passed: false, fullM0A10Passed: false }
}
