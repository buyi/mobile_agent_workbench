import { expect, test } from "bun:test"
import { expectedAdmissionDenial, validateProbeProof } from "../m0/supervisor-probe"

test("finite supervisor probe binds stop proof to scope, generation and dedicated UID/GID", () => {
  const proof = { schemaVersion: "worker-stop-proof/1", scopeId: "scope", generation: 2, workerUid: 420, observedUid: 420,
    observedGid: 420, noLiveWorkerProcesses: true, userDomainAbsent: true, externalActionsVerified: false }
  expect(() => validateProbeProof(proof, "scope", 2)).not.toThrow()
  for (const change of [{ scopeId: "other" }, { generation: 3 }, { workerUid: 0 }, { observedUid: 421 }, { observedGid: 20 },
    { noLiveWorkerProcesses: false }, { userDomainAbsent: false }, { userDomainAbsent: undefined }, { externalActionsVerified: true }])
    expect(() => validateProbeProof({ ...proof, ...change }, "scope", 2)).toThrow("invalid")
})


test("admission negatives require the exact gate reason, never an arbitrary wrapper failure", () => {
  const base = { status: 1, signal: null, stderr: "Traceback...\nRuntimeError: Stale or missing launch scope/generation\n" }
  expect(expectedAdmissionDenial(base, "scope")).toBe(true)
  expect(expectedAdmissionDenial(base, "phase")).toBe(false)
  for (const changed of [{ ...base, status: 0 }, { ...base, status: 2 }, { ...base, error: new Error("ENOENT") },
    { ...base, signal: "SIGTERM" }, { ...base, stderr: "PermissionError: [Errno 13] Permission denied" },
    { ...base, stderr: "sandbox-exec: Operation not permitted" }]) expect(expectedAdmissionDenial(changed, "scope")).toBe(false)
  expect(expectedAdmissionDenial({ ...base, stderr: "RuntimeError: Launch phase or registered identity does not match\n" }, "phase")).toBe(true)
})
