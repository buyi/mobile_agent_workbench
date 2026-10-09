/** Frozen host inputs, not an OS isolation proof or a Worker registration API.
 * The host obtains expected byte pins from protected operator/CI configuration.
 * Neither a model request nor its claimed digest is a trust source. */
import { createHash } from "node:crypto"
import { posix } from "node:path"
import { digestOf } from "../../packages/contracts/src/digest"

export interface DeviceBinding {
  schemaVersion: "device-binding/1"
  resourceId: string
  revision: number
  ownerUid: 422
  privateSet: string
  udid: string
  runtime: string
  deviceType: string
  bundleId: string
  capabilityDigest: string
  executorId: string
  executorDigest: string
}
export const bytesDigest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
export const validDeviceId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
export const validDeviceDigest = (value: unknown): value is string => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)
export function exactDeviceObject(value: unknown, keys: readonly string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) throw new Error("invalid_device_object_fields")
}
export function validateDeviceBinding(input: unknown): DeviceBinding {
  exactDeviceObject(input, ["schemaVersion", "resourceId", "revision", "ownerUid", "privateSet", "udid", "runtime", "deviceType", "bundleId", "capabilityDigest", "executorId", "executorDigest"])
  if (input.schemaVersion !== "device-binding/1" || !validDeviceId(input.resourceId) || !Number.isSafeInteger(input.revision) || input.revision < 1 || input.ownerUid !== 422 ||
      typeof input.privateSet !== "string" || !input.privateSet.startsWith("/private/var/loopit/") || input.privateSet.includes("\0") ||
      posix.normalize(input.privateSet) !== input.privateSet || input.privateSet.endsWith("/") ||
      typeof input.udid !== "string" || !/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(input.udid) ||
      typeof input.runtime !== "string" || !/^com\.apple\.CoreSimulator\.SimRuntime\.[A-Za-z0-9.-]+$/.test(input.runtime) ||
      typeof input.deviceType !== "string" || !/^com\.apple\.CoreSimulator\.SimDeviceType\.[A-Za-z0-9.-]+$/.test(input.deviceType) ||
      typeof input.bundleId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(input.bundleId) ||
      !validDeviceDigest(input.capabilityDigest) || !validDeviceId(input.executorId) || !validDeviceDigest(input.executorDigest)) throw new Error("invalid_device_binding")
  return structuredClone(input) as DeviceBinding
}

export class HostDeviceBindings {
  readonly #bindings = new Map<string, { binding: DeviceBinding; bindingDigest: string; sourceDigest: string }>()
  constructor(inputs: ReadonlyArray<{ bytes: Uint8Array; expectedDigest: string }>) {
    for (const input of inputs) {
      if (!(input.bytes instanceof Uint8Array) || input.bytes.length > 16_384 || !validDeviceDigest(input.expectedDigest) ||
          bytesDigest(input.bytes) !== input.expectedDigest) throw new Error("device_binding_bytes_pin_mismatch")
      const binding = validateDeviceBinding(JSON.parse(Buffer.from(input.bytes).toString("utf8")))
      if (this.#bindings.has(binding.resourceId)) throw new Error("duplicate_host_device_binding")
      this.#bindings.set(binding.resourceId, { binding, bindingDigest: digestOf(binding), sourceDigest: input.expectedDigest })
    }
  }
  get(resourceId: string) {
    const entry = this.#bindings.get(resourceId)
    if (!entry) throw new Error("host_device_binding_unavailable")
    return structuredClone(entry)
  }
}
