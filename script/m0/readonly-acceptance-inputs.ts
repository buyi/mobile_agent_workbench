/** Staging provenance only; protected historical files are never rewritten. */
import { canonicalJson } from "../../packages/contracts/src/digest"
import { byteDigest, verifySignedCheck } from "../../packages/verifier/src/service"

export function originalSignedCheckPin(original: Buffer, exported: Buffer, originalDigest: string, exportDigest: string,
  publicKey: string, expected: Parameters<typeof verifySignedCheck>[2]) {
  if (byteDigest(original) !== originalDigest || byteDigest(exported) !== exportDigest) throw new Error("signed_check_source_bytes_changed")
  const oldValue = JSON.parse(original.toString("utf8")), exportValue = JSON.parse(exported.toString("utf8"))
  if (canonicalJson(oldValue) !== canonicalJson(exportValue)) throw new Error("signed_check_export_semantics_changed")
  if (!verifySignedCheck(oldValue, publicKey, expected) || !verifySignedCheck(exportValue, publicKey, expected))
    throw new Error("signed_check_source_signature_invalid")
  return { originalDigest, exportDigest, sameSignedPayload: true, signatureVerified: true }
}
