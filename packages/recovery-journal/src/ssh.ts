import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs"
import { dirname, isAbsolute, normalize } from "node:path"
import { Schema } from "effect"
import { Digest, Id, Ref } from "../../contracts/src/common"
import { digestOf } from "../../contracts/src/digest"
import { AuthorityProofSchema, decode, JournalAckSchema, JournalError, RequestSchema, ResponseSchema, validPin, type Request } from "./protocol"

export const SSH_REQUEST_SELECTOR = "loopit-recovery-journal-request-v1" as const
const Pin = Schema.Struct({ ref: Ref, digest: Digest })
const SshConfigSchema = Schema.Struct({
  schemaVersion: Schema.Literal("recovery-journal-ssh/1"),
  host: Schema.String, user: Schema.String, port: Schema.Int,
  journalId: Id, ownerId: Id,
  knownHosts: Schema.Struct({ path: Schema.String, digest: Digest }),
  // A path and public fingerprint description, never a private-key digest.
  identity: Schema.Struct({ path: Schema.String, publicFingerprint: Schema.String }),
  forcedCommand: Schema.Struct({ selector: Schema.Literal(SSH_REQUEST_SELECTOR), deploymentRef: Pin }),
  timeoutMs: Schema.optional(Schema.Int),
})
export type SshStdioConfig = typeof SshConfigSchema.Type

const cleanEnvironment = () => ({ PATH: "/usr/bin:/bin", LANG: "C", SSH_ASKPASS_REQUIRE: "never" })
const sha = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const snapshot = (st: Stats) => ({ dev: st.dev, ino: st.ino, uid: st.uid, gid: st.gid,
  mode: st.mode, nlink: st.nlink, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs })

function checkedPath(path: string) {
  // OpenSSH expands tokens/environment variables in several path options.
  // Restrict the supported pathname grammar rather than quoting shell text.
  if (!isAbsolute(path) || normalize(path) !== path || !/^\/[A-Za-z0-9_./-]+$/.test(path) || realpathSync(path) !== path)
    throw new JournalError("ssh_path_not_canonical")
  const uid = process.geteuid!()
  let current = path
  while (true) {
    const st = lstatSync(current)
    const stickyRootDirectory = current !== path && st.isDirectory() && st.uid === 0 && (st.mode & 0o1000) !== 0
    if (st.isSymbolicLink() || (st.uid !== 0 && st.uid !== uid) || (!stickyRootDirectory && (st.mode & 0o022) !== 0) ||
        (current !== path && !st.isDirectory())) throw new JournalError("ssh_reference_not_protected")
    if (process.platform === "darwin") {
      const acl = spawnSync("/bin/ls", ["-lde", current], { env: cleanEnvironment(), encoding: "utf8", timeout: 1000, maxBuffer: 8192 })
      if (acl.error || acl.status !== 0 || acl.signal || acl.stdout.trimEnd().split("\n").length !== 1)
        throw new JournalError("ssh_reference_acl_unverified")
    }
    if (current === "/") break
    current = dirname(current)
  }
  return lstatSync(path)
}

function identityMetadata(path: string) {
  const st = checkedPath(path)
  if (!st.isFile() || st.nlink !== 1 || st.size < 1 || st.size > 1024 * 1024 || (st.mode & 0o077) !== 0)
    throw new JournalError("ssh_identity_attributes_invalid")
  // Deliberately do not open, read, copy or hash the private identity file.
  return snapshot(st)
}

function knownHostsMetadata(pin: SshStdioConfig["knownHosts"]) {
  const before = checkedPath(pin.path)
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 1024 * 1024)
    throw new JournalError("ssh_known_hosts_invalid")
  const fd = openSync(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (digestOf(snapshot(fstatSync(fd))) !== digestOf(snapshot(before))) throw new JournalError("ssh_reference_changed")
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new JournalError("ssh_reference_changed")
      offset += count
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) || sha(bytes) !== pin.digest ||
        digestOf(snapshot(fstatSync(fd))) !== digestOf(snapshot(before)) ||
        digestOf(snapshot(lstatSync(pin.path))) !== digestOf(snapshot(before))) throw new JournalError("ssh_known_hosts_digest_mismatch")
    return snapshot(before)
  } finally { closeSync(fd) }
}

/** Configuration is trusted host input, never a tool/model request. A pinned
 * deploymentRef documents a prerequisite; it does not authenticate a server or
 * establish that its administrator actually installed a forced command. */
export function sshStdioTransport(value: SshStdioConfig) {
  const config = decode(SshConfigSchema, structuredClone(value))
  const labels = config.host.split(".")
  if (config.host.length > 253 || labels.some(label => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)) ||
      !/^[a-z_][a-z0-9_-]{0,63}$/.test(config.user) || config.port < 1 || config.port > 65535 ||
      !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(config.identity.publicFingerprint) || !validPin(config.forcedCommand.deploymentRef))
    throw new JournalError("ssh_configuration_invalid")
  const timeoutMs = config.timeoutMs ?? 10_000
  if (timeoutMs < 1 || timeoutMs > 30_000) throw new JournalError("invalid_timeout")
  // Reject aliasing before reading the public file: a mistaken host-key path
  // must never turn the private identity reference into a hash/read input.
  const identity = identityMetadata(config.identity.path)
  if (config.knownHosts.path === config.identity.path) throw new JournalError("ssh_public_private_reference_alias")
  const initial = { identity, knownHosts: knownHostsMetadata(config.knownHosts) }
  const recheck = () => {
    if (digestOf({ identity: identityMetadata(config.identity.path), knownHosts: knownHostsMetadata(config.knownHosts) }) !== digestOf(initial))
      throw new JournalError("ssh_reference_changed")
  }
  const options = [
    "BatchMode=yes", "StrictHostKeyChecking=yes", `UserKnownHostsFile=${config.knownHosts.path}`, "GlobalKnownHostsFile=/dev/null",
    "KnownHostsCommand=none", "UpdateHostKeys=no", "VerifyHostKeyDNS=no", "CanonicalizeHostname=no",
    "IdentitiesOnly=yes", "IdentityAgent=none", "CertificateFile=none", "PKCS11Provider=none",
    "PreferredAuthentications=publickey", "PasswordAuthentication=no", "KbdInteractiveAuthentication=no",
    "GSSAPIAuthentication=no", "HostbasedAuthentication=no", "NumberOfPasswordPrompts=0",
    "ProxyCommand=none", "ProxyJump=none", "PermitLocalCommand=no", "ClearAllForwardings=yes",
    "ForwardAgent=no", "ForwardX11=no", "Tunnel=no", "ControlMaster=no", "ControlPath=none", "ControlPersist=no",
    "RequestTTY=no", "EscapeChar=none", "ConnectionAttempts=1", `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
    "SendEnv=-*", "LogLevel=ERROR",
  ]
  // SSH uses a remote login shell for exec requests. Send exactly one fixed
  // selector with no metacharacters or arguments; the server must enforce its
  // root-installed forced command and disregard any client owner/admin claims.
  const argv = ["/usr/bin/ssh", "-F", "none", "-T", "-a", "-x", ...options.flatMap(option => ["-o", option]),
    "-i", config.identity.path, "-p", String(config.port), "-l", config.user, "--", config.host, SSH_REQUEST_SELECTOR]

  return async (input: Request): Promise<unknown> => {
    const request = decode(RequestSchema, input)
    if (request.journalId !== config.journalId || (request.method === "reserveDispatch" && request.intent.fence.ownerId !== config.ownerId))
      throw new JournalError("ssh_request_binding_mismatch")
    const bytes = Buffer.from(JSON.stringify(request) + "\n")
    if (bytes.length > 1024 * 1024) throw new JournalError("request_too_large")
    recheck()
    const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: cleanEnvironment(), cwd: "/" })
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async (stream: ReadableStream<Uint8Array>, limit: number, keep: boolean) => {
      let size = 0
      const chunks: Uint8Array[] = []
      for await (const chunk of stream) {
        size += chunk.length
        if (size > limit) throw new JournalError("transport_output_too_large")
        if (keep) chunks.push(chunk)
      }
      return keep ? Buffer.concat(chunks).toString("utf8") : ""
    }
    try {
      const streams = Promise.all([read(child.stdout, 128 * 1024, true), read(child.stderr, 16 * 1024, false), child.exited])
      // A stdin failure can win before the readers reject. Still consume their
      // rejection while cleanup terminates this single local SSH process.
      void streams.catch(() => {})
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new JournalError("transport_timeout")), timeoutMs) })
      const work = async () => { child.stdin.write(bytes); await child.stdin.end(); return streams }
      const [output, , status] = await Promise.race([work(), deadline])
      // Any nonzero SSH/remote exit or signal is unknown, even with buffered ACK.
      if (status !== 0 || child.signalCode) throw new JournalError("transport_failed")
      let raw: unknown
      try { raw = JSON.parse(output) } catch { throw new JournalError("transport_response_invalid") }
      const response = decode(ResponseSchema, raw)
      if (!response.ok || response.journalId !== request.journalId || response.requestId !== request.requestId)
        throw new JournalError("response_binding_mismatch")
      if (request.method === "reserveDispatch") {
        const ack = decode(JournalAckSchema, response.value)
        if (digestOf(ack.intent) !== digestOf(request.intent) || ack.durable.digest !== digestOf(request.intent) || !validPin(ack.durable) ||
            ack.durable.ref !== `journal://${config.journalId}/dispatch/${request.intent.dispatchId}#${digestOf(request.intent)}`)
          throw new JournalError("invalid_journal_ack")
      } else {
        const proof = decode(AuthorityProofSchema, response.value)
        const digest = digestOf({ schemaVersion: "recovery-authority/1", journalId: config.journalId, scopeId: request.scopeId, fence: proof.fence })
        if (proof.scopeId !== request.scopeId || proof.fence.ownerId !== config.ownerId || proof.proof.digest !== digest || !validPin(proof.proof) ||
            proof.proof.ref !== `journal://${config.journalId}/authority/${request.scopeId}/${proof.fence.generation}/${proof.fence.epoch}#${digest}`)
          throw new JournalError("invalid_authority_proof")
      }
      recheck()
      return response
    } finally {
      if (timer) clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      // Killing the local SSH client does not prove the remote COMMIT was
      // cancelled. No retry or new permit is issued on any uncertain outcome.
    }
  }
}
