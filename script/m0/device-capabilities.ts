/** Host configuration for the existing operator experiment. This is not an OS
 * isolation credential. There is deliberately no os-exclusive registration or
 * autonomous positive path until a separately verified device boundary exists. */
import { createHash } from "node:crypto"
import { lstatSync, readFileSync } from "node:fs"
import { digestOf } from "../../packages/contracts/src/digest"

export interface ProbeDeviceRegistration {
  resourceId: string
  observedAt: string
  osExclusiveControl: false
  sourceRefs: ReadonlyArray<{ ref: string; digest: string }>
}
export interface OperatorProbeUse { purpose: "operator-probe-only"; experimentId: string }
export interface AutonomousDeviceUse { purpose: "autonomous"; taskId: string; runId: string; goalRevision: number; goalDigest: string }
export type DeviceUse = OperatorProbeUse | AutonomousDeviceUse
export interface ProbeAdmission extends OperatorProbeUse { capabilityDigest: string }
/** Future host authority port. No autonomous implementation is provided here.
 * Its constructor belongs to trusted host wiring, never to a request payload. */
export interface AutonomousAdmission extends AutonomousDeviceUse { capabilityDigest: string; bindingDigest: string }
export type DeviceAdmission = ProbeAdmission | AutonomousAdmission
export interface DeviceAdmissionAuthority {
  admit(resourceId: string, use?: DeviceUse): DeviceAdmission
  assert(resourceId: string, admission: DeviceAdmission | undefined, use?: DeviceUse): void
}
const validId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
const digest = (value: unknown) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)
const exact = (value: object, keys: string[]) => Object.keys(value).sort().join() === keys.sort().join()
const byteDigest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`

export class DeviceCapabilityRegistry implements DeviceAdmissionAuthority {
  readonly #resources = new Map<string, ProbeDeviceRegistration>()
  constructor(registrations: ReadonlyArray<ProbeDeviceRegistration> = []) {
    for (const entry of registrations) {
      if (!entry || !exact(entry, ["resourceId", "observedAt", "osExclusiveControl", "sourceRefs"]) ||
        !validId(entry.resourceId) || entry.osExclusiveControl !== false || !Number.isFinite(Date.parse(entry.observedAt)) ||
        !Array.isArray(entry.sourceRefs) || !entry.sourceRefs.length || entry.sourceRefs.length > 8 ||
        entry.sourceRefs.some((pin) => !pin || !exact(pin, ["ref", "digest"]) || typeof pin.ref !== "string" ||
          !/^artifact:\/\/[^\s#]+$/.test(pin.ref) || !digest(pin.digest)) || this.#resources.has(entry.resourceId))
        throw new Error("invalid_probe_only_device_registration")
      this.#resources.set(entry.resourceId, structuredClone(entry))
    }
  }
  describe(resourceId: string) {
    if (!validId(resourceId)) throw new Error("invalid_device_capability_resource")
    const entry = this.#resources.get(resourceId)
    return { schemaVersion: "device-capability/1" as const, resourceId,
      status: entry ? "probe-only" as const : "unregistered" as const,
      capabilityDigest: entry ? digestOf(entry) : null,
      operatorProbeAllowed: !!entry, autonomousDispatchAllowed: false as const, osExclusiveControl: false as const,
      reason: entry ? "device_os_exclusivity_unproven" : "device_capability_unregistered",
      sourceRefs: structuredClone(entry?.sourceRefs ?? []),
      limitation: "Same OS UID may bypass this broker with simctl; probe admission is operator experiment scope, not an isolation credential." }
  }
  admit(resourceId: string, use?: DeviceUse): ProbeAdmission {
    const capability = this.describe(resourceId)
    // An omitted use is a production/default call, never an implicit probe.
    if (!use || use.purpose === "autonomous") throw new Error(capability.reason)
    if (!exact(use, ["purpose", "experimentId"]) || use.purpose !== "operator-probe-only" || !validId(use.experimentId))
      throw new Error("invalid_operator_probe_scope")
    if (!capability.operatorProbeAllowed) throw new Error(capability.reason)
    return { purpose: "operator-probe-only", experimentId: use.experimentId, capabilityDigest: capability.capabilityDigest! }
  }
  assert(resourceId: string, admission: DeviceAdmission | undefined, use?: DeviceUse) {
    const expected = this.admit(resourceId, use)
    if (!admission || digestOf(admission) !== digestOf(expected)) throw new Error("device_admission_scope_mismatch")
  }
}

/** Read existing nonsecret reports only. Their digest linkage can register a
 * probe-only resource; it cannot upgrade a self-reported OS property to trust. */
export function registryFromIosObservation(resultPath: string, auditPath: string) {
  const read = (path: string) => {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 ** 2) throw new Error("invalid_device_observation_file")
    const bytes = readFileSync(path)
    if (bytes.length !== stat.size) throw new Error("device_observation_changed")
    return { bytes, value: JSON.parse(bytes.toString("utf8")), digest: byteDigest(bytes) }
  }
  const result = read(resultPath), audit = read(auditPath), r = result.value, a = audit.value
  if (r.schemaVersion !== "ios-broker-experiment/1" || r.status !== "local-protocol-experiment-passed" ||
    a.schemaVersion !== "ios-broker-evidence-audit/1" || a.resultDigest !== result.digest ||
    r.osExclusiveControl !== false || a.osExclusiveControl !== false || r.fullM0A08Passed !== false ||
    r.fullM0A10Passed !== false || a.signedGate !== false || !validId(r.target?.udid))
    throw new Error("device_observation_is_not_bound_probe_only_evidence")
  const registration: ProbeDeviceRegistration = { resourceId: r.target.udid, observedAt: r.finishedAt, osExclusiveControl: false,
    sourceRefs: [{ ref: `artifact://device-observation/${r.target.udid}/result.json`, digest: result.digest },
      { ref: `artifact://device-observation/${r.target.udid}/evidence-audit.json`, digest: audit.digest }] }
  return { registry: new DeviceCapabilityRegistry([registration]), registration }
}
