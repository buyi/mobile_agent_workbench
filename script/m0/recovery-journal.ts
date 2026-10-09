// Local CLI only. JSON stdin contains exactly one request; stdout one response.
// bun script/m0/recovery-journal.ts init --db /dedicated/existing-dir/journal.db
// bun script/m0/recovery-journal.ts admin --db <absolute> --journal-id <trusted-id>
// bun script/m0/recovery-journal.ts request --db <absolute> --journal-id <trusted-id> --owner-id <trusted-owner>
// The host/transport must restrict admin access and bind owner-id (e.g. a future
// forced command). CLI flags and a journal ID are not authentication or isolation.
import { AdminRequestSchema, decode, initializeDatabase, JournalError, JournalStore, RequestSchema } from "../../packages/recovery-journal/src"

async function readRequest(): Promise<unknown> {
  const reader = Bun.stdin.stream().getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = async () => {
    const chunks: Uint8Array[] = []; let size = 0
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.length
      if (size > 1024 * 1024) throw new JournalError("request_too_large")
      chunks.push(result.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) }
    catch { throw new JournalError("invalid_json") }
  }
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new JournalError("request_timeout")), 5_000)
    })])
  } finally { if (timer) clearTimeout(timer); void reader.cancel().catch(() => {}) }
}

const mode = process.argv[2]
const flags: Record<string, string> = {}
let requestId = "invalid", journalId = "unknown", store: JournalStore | undefined
try {
  const allowed = mode === "init" ? ["db"] : mode === "admin" ? ["db", "journal-id"] : mode === "request" ? ["db", "journal-id", "owner-id"] : []
  if (!allowed.length) throw new JournalError("invalid_command")
  for (let i = 3; i < process.argv.length; i += 2) {
    const key = process.argv[i].replace(/^--/, ""), value = process.argv[i + 1]
    if (!process.argv[i].startsWith("--") || !allowed.includes(key) || !value || flags[key]) throw new JournalError("invalid_arguments")
    flags[key] = value
  }
  if (allowed.some((key) => !flags[key])) throw new JournalError("missing_arguments")
  journalId = flags["journal-id"] ?? "unknown"
  let value: unknown
  if (mode === "init") {
    requestId = "initialize-database"
    value = initializeDatabase(flags.db)
    journalId = (value as { journalId: string }).journalId
  } else {
    const raw = await readRequest()
    const request = mode === "admin" ? decode(AdminRequestSchema, raw) : decode(RequestSchema, raw)
    requestId = request.requestId
    if (request.journalId !== journalId) throw new JournalError("journal_identity_mismatch")
    store = new JournalStore(flags.db, journalId)
    switch (request.method) {
      case "initializeScope": value = store.initializeScope(request.scopeId, request.fence); break
      case "advanceFence": value = store.advanceFence(request.scopeId, request.expectedFence, request.nextOwnerId); break
      case "currentAuthority": value = store.currentAuthority(request.scopeId); break
      case "reserveDispatch": value = store.reserveDispatch(request.intent, flags["owner-id"]); break
    }
    store.close(); store = undefined
  }
  // No acknowledgement can reach stdout before the store's synchronous COMMIT.
  await Bun.write(Bun.stdout, JSON.stringify({ schemaVersion: "recovery-journal-response/1", requestId, journalId, ok: true, value }) + "\n")
} catch (error) {
  store?.close()
  await Bun.write(Bun.stdout, JSON.stringify({ schemaVersion: "recovery-journal-response/1", requestId, journalId, ok: false,
    error: { code: error instanceof JournalError ? error.code : "journal_unavailable" } }) + "\n")
  process.exitCode = 2
}
