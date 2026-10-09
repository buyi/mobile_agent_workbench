import { CONFIG_PATH, SIGNER_UID, openVerifier, verifyCandidate } from "../../packages/verifier/src/service"

async function readInput() {
  const reader = Bun.stdin.stream().getReader()
  const chunks: Uint8Array[] = []
  let size = 0, timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        while (true) {
          const value = await reader.read()
          if (value.done) break
          size += value.value.length
          if (size > 32 * 1024) throw new Error("request_too_large")
          chunks.push(value.value)
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"))
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("request_timeout")), 5000) }),
    ])
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}) }
}

try {
  if (process.argv.length !== 2) throw new Error("cli_arguments_not_allowed")
  if (process.getuid?.() !== SIGNER_UID) throw new Error("signer_identity_required")
  const loaded = openVerifier(CONFIG_PATH, SIGNER_UID)
  const result = await verifyCandidate(loaded, await readInput())
  await Bun.write(Bun.stdout, JSON.stringify(result) + "\n")
  process.exitCode = result.status === "passed" ? 0 : 2
} catch (error) {
  // Do not serialize opaque errors, PEM content, caller data or environment.
  const message = error instanceof Error ? error.message : "verifier_unavailable"
  const code = /^[a-z][a-z0-9_]{0,80}$/.test(message) ? message : "verifier_unavailable"
  await Bun.write(Bun.stdout, JSON.stringify({ schemaVersion: "verify-candidate-response/1", status: "blocked", error: code }) + "\n")
  process.exitCode = 2
}
