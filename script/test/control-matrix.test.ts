import { expect, test } from "bun:test"
import { digestOf } from "../../packages/contracts/src"
import { controlMatrixProofs, controlMatrixResumeAuthority } from "../m0/control-matrix-authority"
function fixture() {
  const proof = (uid: number, account: string) => ({ schemaVersion: "worker-stop-proof/1", scopeId: "scope-1", generation: 1,
    observedUid: uid, observedGid: 420, workerUid: 420, serviceAccount: account,
    noLiveWorkerProcesses: true, userDomainAbsent: true, externalActionsVerified: false,
    observations: Array.from({ length: 3 }, () => ({ userDomainPresent: false, processes: [] })) })
  const active = { scopeId: "scope-1", generation: 1, phase: "finalizing", stopProof: proof(420, "loopit-worker"), signerStopProof: proof(421, "loopit-signer") }
  const authority = { pair: controlMatrixProofs(active, "scope-1", 1), execution: { operationId: "op-1" } }
  const saved = { scopeId: "scope-1", generation: 1, mode: "pause", record: { handle: { operationId: "op-1" } }, authority,
    stopAuthorization: { previousOperationId: "op-1", stopProofDigest: digestOf(authority) } }
  const current = { scopeId: "scope-2", generation: 2, phase: "running", priorStopProofs: authority.pair }
  return { active, authority, saved, current }
}
test("matrix requires dual dedicated UID, absent domains and current finalizing scope", () => {
  const f = fixture()
  expect(controlMatrixProofs(f.active, "scope-1", 1)).toEqual(f.authority.pair)
  for (const mutate of [
    (a: any) => a.phase = "running", (a: any) => a.generation++, (a: any) => delete a.signerStopProof,
    (a: any) => a.signerStopProof.observedUid = 420, (a: any) => a.stopProof.userDomainAbsent = false,
    (a: any) => a.stopProof.observations[2].processes = [{ state: "S" }],
  ]) { const altered = structuredClone(f.active); mutate(altered); expect(() => controlMatrixProofs(altered, "scope-1", 1)).toThrow() }
})
test("cold resume binds immediately prior Supervisor scope and original persisted pause authorization", () => {
  const f = fixture()
  expect(controlMatrixResumeAuthority(f.current, "scope-2", 2, f.saved)).toEqual(f.authority.pair)
  for (const mutate of [ (a: any) => a.scopeId = "other", (a: any) => a.mode = "cancel", (a: any) => a.stopAuthorization.previousOperationId = "other",
    (a: any) => a.authority.execution.operationId = "other", (a: any) => a.stopAuthorization.stopProofDigest = digestOf("wrong") ]) {
    const altered = structuredClone(f.saved); mutate(altered); expect(() => controlMatrixResumeAuthority(f.current, "scope-2", 2, altered)).toThrow()
  }
  expect(() => controlMatrixResumeAuthority({ ...f.current, priorStopProofs: undefined }, "scope-2", 2, f.saved)).toThrow()
})
