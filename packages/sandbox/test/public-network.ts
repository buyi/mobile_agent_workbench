import { isIPv4 } from "node:net"

/** Fixed IPv4 only: local/special-use destinations cannot stand in for public TCP. */
export function publicProbeIPv4(value = "1.1.1.1") {
  if (!isIPv4(value)) throw new Error("Public TCP probe requires a canonical IPv4 literal")
  const [a, b, c] = value.split(".").map(Number)
  const special = a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  if (special) throw new Error("Public TCP probe rejects private, loopback, and special-use IPv4 destinations")
  return value
}
