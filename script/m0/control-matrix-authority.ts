/** Pure checks shared by the deployed no-model controller and ordinary tests. */
import { digestOf } from "../../packages/contracts/src"
import { preparationStopAuthority } from "./control-loop-authority"

export function controlMatrixProofs(active: any, scopeId: string, generation: number) {
  if (active.scopeId !== scopeId || active.generation !== generation || active.phase !== "finalizing")
    throw new Error("control_matrix_finalizing_scope_required")
  const pair = { scopeId, generation, worker: active.stopProof, signer: active.signerStopProof }
  // Reuse the exact dual identity/schema/domain/three-observation checks. Only
  // the wrapper's current-phase check differs; no external fact is invented.
  preparationStopAuthority({ scopeId: "pure-validation-successor", generation: generation + 1,
    phase: "running", priorStopProofs: pair }, "pure-validation-successor", generation + 1)
  return pair
}
export function controlMatrixResumeAuthority(active: any, scopeId: string, generation: number, saved: any) {
  const prior = preparationStopAuthority(active, scopeId, generation)
  if (prior.scopeId !== saved.scopeId || prior.generation !== saved.generation ||
      saved.mode !== "pause" || !saved.record?.handle || !saved.stopAuthorization ||
      saved.stopAuthorization.previousOperationId !== saved.record.handle.operationId ||
      saved.stopAuthorization.stopProofDigest !== digestOf(saved.authority))
    throw new Error("control_matrix_resume_scope_mismatch")
  return prior
}
