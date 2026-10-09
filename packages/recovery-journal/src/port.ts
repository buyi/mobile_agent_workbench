import { randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import { Effect } from "effect"
import { digestOf } from "../../contracts/src/digest"
import { Id } from "../../contracts/src/common"
import type { RecoveryJournal } from "../../delivery/src/operation-ledger"
import { AuthorityProofSchema, decode, JournalAckSchema, JournalError, ResponseSchema, validPin, type Request } from "./protocol"

/** Transport and journal identity are trusted operator configuration. No retries:
 * a transport failure may mean COMMIT succeeded but the acknowledgement was lost. */
export function createRecoveryJournal(options: { journalId: string; transport: (request: Request) => Promise<unknown> }): RecoveryJournal {
  decode(Id, options.journalId)
  const call = async (request: Request) => {
    const response = decode(ResponseSchema, await options.transport(request))
    if (response.journalId !== options.journalId || response.requestId !== request.requestId) throw new JournalError("response_binding_mismatch")
    if (!response.ok) throw new JournalError(response.error.code)
    return response.value
  }
  const envelope = () => ({ schemaVersion: "recovery-journal-request/1" as const, requestId: randomUUID(), journalId: options.journalId })
  return {
    currentAuthority: (scopeId) => Effect.tryPromise(async () => {
      const proof = decode(AuthorityProofSchema, await call({ ...envelope(), method: "currentAuthority", scopeId }))
      const digest = digestOf({ schemaVersion: "recovery-authority/1", journalId: options.journalId, scopeId, fence: proof.fence })
      if (proof.scopeId !== scopeId || proof.proof.digest !== digest || !validPin(proof.proof) ||
        proof.proof.ref !== `journal://${options.journalId}/authority/${scopeId}/${proof.fence.generation}/${proof.fence.epoch}#${digest}`)
        throw new JournalError("invalid_authority_proof")
      return proof
    }),
    reserveDispatch: (intent) => Effect.tryPromise(async () => {
      const ack = decode(JournalAckSchema, await call({ ...envelope(), method: "reserveDispatch", intent }))
      if (digestOf(ack.intent) !== digestOf(intent) || ack.durable.digest !== digestOf(intent) || !validPin(ack.durable) ||
        ack.durable.ref !== `journal://${options.journalId}/dispatch/${intent.dispatchId}#${digestOf(intent)}`) throw new JournalError("invalid_journal_ack")
      return ack
    }),
  }
}

/** Local subprocess transport for conformance tests and trusted local integration.
 * This does not establish an independent host, credential or fault domain. */
export function localStdioTransport(options: { cliPath: string; databasePath: string; journalId: string; ownerId: string; timeoutMs?: number }) {
  if (!isAbsolute(options.cliPath) || !isAbsolute(options.databasePath)) throw new JournalError("absolute_path_required")
  decode(Id, options.journalId); decode(Id, options.ownerId)
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new JournalError("invalid_timeout")
  return async (request: Request): Promise<unknown> => {
    const child = Bun.spawn([process.execPath, options.cliPath, "request", "--db", options.databasePath,
      "--journal-id", options.journalId, "--owner-id", options.ownerId], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      child.stdin.write(JSON.stringify(request) + "\n"); child.stdin.end()
      const read = async () => {
        const chunks: Uint8Array[] = []
        let size = 0
        for await (const chunk of child.stdout) {
          size += chunk.length
          if (size > 128 * 1024) throw new JournalError("response_too_large")
          chunks.push(chunk)
        }
        return Buffer.concat(chunks).toString("utf8")
      }
      const [output, status] = await Promise.race([
        Promise.all([read(), child.exited]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new JournalError("transport_timeout")), timeoutMs) }),
      ])
      if (status !== 0 && status !== 2) throw new JournalError("transport_failed")
      const response = decode(ResponseSchema, JSON.parse(output))
      // Buffered stdout can survive a failed child. A syntactically valid ACK
      // is not success unless the process itself completed successfully.
      if ((status === 0) !== response.ok) throw new JournalError("transport_failed")
      return response
    } finally {
      if (timer) clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
    }
  }
}
