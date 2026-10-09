import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Exit } from "effect"
import { digestOf } from "../../contracts/src/digest"
import type { DispatchIntent, Fence } from "../../delivery/src/operation-ledger"
import { createRecoveryJournal, decode, JournalStore, localStdioTransport, ResponseSchema, type Request } from "../src"

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const cli = resolve(import.meta.dir, "../../../script/m0/recovery-journal.ts")
const fence: Fence = { ownerId: "worker-1", generation: 1, epoch: 1 }
type Fixture = { directory: string; database: string; journalId: string }
const args = (f: Fixture, mode: string, ownerId = "worker-1") => [process.execPath, cli, mode, "--db", f.database,
  ...(mode === "init" ? [] : ["--journal-id", f.journalId]), ...(mode === "request" ? ["--owner-id", ownerId] : [])]
const request = (f: Fixture, body: Record<string, unknown>) => ({ schemaVersion: "recovery-journal-request/1", requestId: "request-1", journalId: f.journalId, ...body })
const call = (f: Fixture, mode: string, body?: Record<string, unknown>, ownerId?: string) => {
  const result = spawnSync(args(f, mode, ownerId)[0], args(f, mode, ownerId).slice(1), {
    input: body ? JSON.stringify(request(f, body)) + "\n" : undefined, timeout: 10_000, encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  const value = JSON.parse(result.stdout)
  decode(ResponseSchema, value)
  expect(result.status).toBe(value.ok ? 0 : 2)
  expect(result.stdout.trim().split("\n")).toHaveLength(1)
  return value
}
const fixture = (): Fixture => {
  const directory = mkdtempSync(join(tmpdir(), "loopit-journal-")); directories.push(directory)
  const f = { directory, database: join(directory, "recovery.db"), journalId: "unknown" }
  const initialized = call(f, "init")
  expect(initialized.ok).toBe(true)
  f.journalId = initialized.journalId
  expect(call(f, "admin", { method: "initializeScope", scopeId: "channel-1", fence }).ok).toBe(true)
  return f
}
const intent = (patch: Partial<DispatchIntent> = {}): DispatchIntent => {
  const requestDigest = digestOf({ candidate: "candidate-1", target: "channel-1" })
  return { scopeId: "channel-1", operationId: "operation-1", idempotencyKey: "candidate-1:channel-1", requestDigest,
    requestRef: { ref: `artifact://request-1#${requestDigest}`, digest: requestDigest }, dispatchId: "dispatch-1", fence, ...patch }
}
const reserve = (f: Fixture, value = intent(), ownerId?: string) => call(f, "request", { method: "reserveDispatch", intent: value }, ownerId)
const parallel = async (f: Fixture, mode: string, bodies: Record<string, unknown>[]) => Promise.all(bodies.map(async (body) => {
  const child = Bun.spawn(args(f, mode), { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } })
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
  try {
    child.stdin.write(JSON.stringify(request(f, body))); child.stdin.end()
    const [text, exit] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect([0, 2]).toContain(exit)
    return JSON.parse(text)
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL") }
}))

describe("standalone SQLite recovery journal — local protocol tests, not M0-A11 isolation evidence", () => {
  test("a process restart retains authority and the full intent committed before its acknowledgement", () => {
    const f = fixture(), value = intent()
    expect(statSync(f.database).mode & 0o777).toBe(0o600)
    const ack = reserve(f, value)
    expect(ack.ok).toBe(true)
    expect(ack.value.intent).toEqual(value)
    expect(ack.value.durable.digest).toBe(digestOf(value))
    expect(ack.value.durable.ref).toContain(`journal://${f.journalId}/`)
    const proof = call(f, "request", { method: "currentAuthority", scopeId: "channel-1" })
    expect(proof.value.fence).toEqual(fence)
    const connection = new Database(f.database, { readonly: true })
    try {
      const row = connection.query("SELECT intent_json, intent_digest FROM reservation").get() as { intent_json: string; intent_digest: string }
      expect(JSON.parse(row.intent_json)).toEqual(value)
      expect(row.intent_digest).toBe(ack.value.durable.digest)
    } finally { connection.close() }
    expect(reserve(f, value).error.code).toBe("already_reserved")
    expect(reserve(f, intent({ dispatchId: "new-dispatch" })).error.code).toBe("already_reserved")
  })
  test("concurrent processes grant exactly one reservation for a logical side effect", async () => {
    const f = fixture()
    const results = await parallel(f, "request", Array.from({ length: 5 }, (_, i) => ({ method: "reserveDispatch",
      intent: intent({ operationId: `operation-${i}`, dispatchId: `dispatch-${i}` }) })))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => r.error?.code === "logical_identity_conflict")).toHaveLength(4)
  }, 20_000)
  test("SIGKILL after COMMIT and before acknowledgement never permits a replay", async () => {
    const f = fixture(), input = join(f.directory, "intent.json"), marker = join(f.directory, "committed")
    writeFileSync(input, JSON.stringify(intent()))
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "crash-child.ts"), f.database, f.journalId, input, marker],
      { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } })
    try {
      const deadline = Date.now() + 5_000
      while (!existsSync(marker) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20)
      expect(existsSync(marker)).toBe(true)
      child.kill("SIGKILL"); await child.exited
      expect(await new Response(child.stdout).text()).toBe("")
      expect(reserve(f).error.code).toBe("already_reserved")
    } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited } }
  }, 15_000)
  test("old business snapshots cannot reuse the key with a changed operation ID or request even after fencing", () => {
    const f = fixture(); expect(reserve(f).ok).toBe(true)
    const advanced = call(f, "admin", { method: "advanceFence", scopeId: "channel-1", expectedFence: fence, nextOwnerId: "worker-2" })
    const next = advanced.value.fence
    expect(next).toEqual({ ownerId: "worker-2", generation: 2, epoch: 2 })
    expect(reserve(f, intent({ operationId: "from-backup", dispatchId: "new-dispatch", fence: next }), "worker-2").error.code).toBe("logical_identity_conflict")
    const digest = digestOf("new request")
    expect(reserve(f, intent({ requestDigest: digest, requestRef: { ref: "artifact://new", digest }, fence: next }), "worker-2").error.code).toBe("logical_identity_conflict")
    expect(reserve(f, intent({ operationId: "old-owner-new-op", idempotencyKey: "new-key" })).error.code).toBe("stale_fence")
  })
  test("administrative advancement is compare-and-swap and cannot reuse an earlier fence", async () => {
    const f = fixture()
    const results = await parallel(f, "admin", ["worker-2", "worker-3"].map((nextOwnerId) => ({ method: "advanceFence", scopeId: "channel-1", expectedFence: fence, nextOwnerId })))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => r.error?.code === "stale_fence")).toHaveLength(1)
    expect(call(f, "admin", { method: "initializeScope", scopeId: "channel-1", fence }).error.code).toBe("scope_already_initialized")
  }, 15_000)
  test("operation IDs remain globally unique across scopes and all outcome uncertainty", () => {
    const f = fixture(); expect(reserve(f).ok).toBe(true)
    expect(call(f, "admin", { method: "initializeScope", scopeId: "channel-2", fence }).ok).toBe(true)
    expect(reserve(f, intent({ scopeId: "channel-2", idempotencyKey: "another-key", dispatchId: "another-dispatch" })).error.code).toBe("operation_id_reused")
  })
  test("wrong journal identity, owner binding and conflicting content pins fail closed", () => {
    const f = fixture()
    expect(call({ ...f, journalId: "wrong-journal" }, "request", { method: "currentAuthority", scopeId: "channel-1" }).error.code).toBe("journal_identity_mismatch")
    expect(reserve(f, intent(), "unrelated-owner").error.code).toBe("owner_not_authorized")
    const malformed = intent(); malformed.requestRef.ref = `artifact://request#${digestOf("different bytes")}`
    expect(reserve(f, malformed).error.code).toBe("request_digest_mismatch")
    expect(reserve(f).ok).toBe(true)
  })
  test("the request command cannot invoke admin methods or silently initialize/overwrite databases", () => {
    const f = fixture()
    expect(call(f, "request", { method: "advanceFence", scopeId: "channel-1", expectedFence: fence, nextOwnerId: "worker-2" }).error.code).toBe("invalid_request")
    const bytes = readFileSync(f.database)
    expect(call(f, "init").ok).toBe(false)
    expect(readFileSync(f.database)).toEqual(bytes)
    const missing = { ...f, database: join(f.directory, "missing.db") }
    expect(call(missing, "request", { method: "currentAuthority", scopeId: "channel-1" }).ok).toBe(false)
    expect(existsSync(missing.database)).toBe(false)
  })
  test("the RecoveryJournal adapter uses a separate process and validates response binding", async () => {
    const f = fixture()
    const transport = localStdioTransport({ cliPath: cli, databasePath: f.database, journalId: f.journalId, ownerId: fence.ownerId })
    const port = createRecoveryJournal({ journalId: f.journalId, transport })
    expect((await Effect.runPromise(port.currentAuthority("channel-1"))).fence).toEqual(fence)
    const ack = await Effect.runPromise(port.reserveDispatch(intent()))
    expect(ack.durable.digest).toBe(digestOf(intent()))
    await expect(Effect.runPromise(port.reserveDispatch(intent()))).rejects.toThrow()
    const wrong = createRecoveryJournal({ journalId: f.journalId, transport: async (request: Request) => ({ ...(await transport(request) as object), journalId: "another-journal" }) })
    await expect(Effect.runPromise(wrong.currentAuthority("channel-1"))).rejects.toThrow()
    const mismatchedAck = createRecoveryJournal({ journalId: f.journalId, transport: async (request: Request) => ({
      schemaVersion: "recovery-journal-response/1", requestId: request.requestId, journalId: f.journalId, ok: true,
      value: { ...ack, durable: { ...ack.durable, ref: `journal://${f.journalId}/dispatch/another-dispatch#${ack.durable.digest}` } },
    }) })
    await expect(Effect.runPromise(mismatchedAck.reserveDispatch(intent()))).rejects.toThrow()
  })
  for (const failure of ["exit-2", "sigkill"] as const)
    test(`a valid ACK followed by ${failure} is rejected without retry or reservation`, async () => {
      const f = fixture(), failedCli = join(f.directory, "failed-cli.ts"), calls = join(f.directory, "calls")
      writeFileSync(failedCli, `
        import {appendFileSync} from "node:fs";
        import {digestOf} from ${JSON.stringify(resolve(import.meta.dir, "../../contracts/src/digest.ts"))};
        const request=JSON.parse(await Bun.stdin.text());
        appendFileSync(${JSON.stringify(calls)}, "called\\n");
        const digest=digestOf(request.intent);
        await Bun.write(Bun.stdout, JSON.stringify({schemaVersion:"recovery-journal-response/1",requestId:request.requestId,
          journalId:request.journalId,ok:true,value:{intent:request.intent,durable:{digest,
          ref:"journal://"+request.journalId+"/dispatch/"+request.intent.dispatchId+"#"+digest}}})+"\\n");
        ${failure === "exit-2" ? "process.exit(2)" : "process.kill(process.pid, 'SIGKILL')"};
      `)
      const transport = localStdioTransport({ cliPath: failedCli, databasePath: f.database, journalId: f.journalId, ownerId: fence.ownerId })
      const port = createRecoveryJournal({ journalId: f.journalId, transport })
      expect(Exit.isFailure(await Effect.runPromise(port.reserveDispatch(intent()).pipe(Effect.exit)))).toBe(true)
      expect(readFileSync(calls, "utf8")).toBe("called\n")
      const db = new Database(f.database, { readonly: true })
      try { expect((db.query("SELECT count(*) AS count FROM reservation").get() as { count: number }).count).toBe(0) }
      finally { db.close() }
    })
  test("an initialized journal reopens in WAL mode", () => {
    const f = fixture()
    const store = new JournalStore(f.database, f.journalId)
    try { expect(store.currentAuthority("channel-1").fence).toEqual(fence) } finally { store.close() }
    const db = new Database(f.database, { readonly: true })
    try { expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal") }
    finally { db.close() }
  })
})
