import { afterEach, expect, spyOn, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { digestOf } from "../../contracts/src/digest"
import { createRecoveryJournal, SSH_REQUEST_SELECTOR, sshStdioTransport, type Request, type SshStdioConfig } from "../src"

const cleanups: Array<() => void> = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })
const bytesDigest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopit-ssh-offline-")))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const known = "journal.example.invalid ssh-ed25519 TEST-ONLY-NOT-A-HOST-KEY\n"
  const identity = join(root, "synthetic-identity")
  writeFileSync(identity, "synthetic fixture; not a private key", { mode: 0o600 })
  const knownHosts = join(root, "known_hosts")
  writeFileSync(knownHosts, known, { mode: 0o600 })
  const config: SshStdioConfig = { schemaVersion: "recovery-journal-ssh/1", host: "journal.example.invalid", user: "journal_worker", port: 2222,
    journalId: "journal-1", ownerId: "worker-1", knownHosts: { path: knownHosts, digest: bytesDigest(known) },
    identity: { path: identity, publicFingerprint: "SHA256:" + "a".repeat(43) },
    forcedCommand: { selector: SSH_REQUEST_SELECTOR, deploymentRef: { ref: "artifact://future-forced-command", digest: digestOf("test-only prerequisite, not deployed") } }, timeoutMs: 3000 }
  const calls = join(root, "calls"), child = join(root, "fake-ssh.ts")
  writeFileSync(child, `import {appendFileSync} from "node:fs";
    import {digestOf} from ${JSON.stringify(resolve(import.meta.dir, "../../contracts/src/digest.ts"))};
    const [mode,calls]=process.argv.slice(2); appendFileSync(calls,"called\\n");
    const r=JSON.parse(await Bun.stdin.text());
    if(mode==="timeout") {setInterval(()=>{},1000);await new Promise(()=>{});}
    if(mode==="stdout-flood") {process.stdout.write("x".repeat(150000));process.exit(0);}
    if(mode==="stderr-flood") {process.stderr.write("x".repeat(20000));process.exit(0);}
    let value;
    if(r.method==="currentAuthority") {const fence={ownerId:mode==="wrong-owner"?"other-owner":"worker-1",generation:1,epoch:1};
      const digest=digestOf({schemaVersion:"recovery-authority/1",journalId:r.journalId,scopeId:r.scopeId,fence});
      value={scopeId:r.scopeId,fence,proof:{digest,ref:"journal://"+r.journalId+"/authority/"+r.scopeId+"/1/1#"+digest}};
    } else {if(mode==="changed-intent")r.intent.operationId="substituted";const digest=digestOf(r.intent);
      value={intent:r.intent,durable:{digest,ref:"journal://"+r.journalId+"/dispatch/"+(mode==="changed-ref"?"wrong":r.intent.dispatchId)+"#"+digest}};}
    const response={schemaVersion:"recovery-journal-response/1",requestId:mode==="wrong-request"?"wrong":r.requestId,
      journalId:mode==="wrong-journal"?"wrong":r.journalId,ok:true,value};
    let output=JSON.stringify(mode==="false-success"?{...response,ok:false,value:undefined,error:{code:"denied"}}:response)+"\\n";
    if(mode==="truncated")output=output.slice(0,-8);
    if(mode==="two-responses")output+=output;
    await Bun.write(Bun.stdout,output);
    if(mode==="exit-2")process.exit(2);
    if(mode==="exit-255")process.exit(255);
    if(mode==="sigkill")process.kill(process.pid,"SIGKILL");
  `)
  const request = (): Request => ({ schemaVersion: "recovery-journal-request/1", requestId: "request-1", journalId: "journal-1",
    method: "reserveDispatch", intent: { scopeId: "scope-1", operationId: "operation-1", dispatchId: "dispatch-1", idempotencyKey: "fixed-business-key",
      requestDigest: digestOf("request"), requestRef: { ref: "artifact://request", digest: digestOf("request") }, fence: { ownerId: "worker-1", generation: 1, epoch: 1 } } })
  return { root, config, calls, child, request }
}

function fakeSsh(f: ReturnType<typeof fixture>, mode: string) {
  const spawn = Bun.spawn.bind(Bun)
  const seen: Array<{ argv: string[]; env: Record<string, string>; cwd: string }> = []
  // The only process in transport tests is this real fixture child. No ssh
  // connection, sshd, network listener, private key or credential discovery.
  const mock = spyOn(Bun, "spawn").mockImplementation(((argv: string[], options: any) => {
    seen.push({ argv: [...argv], env: { ...options.env }, cwd: options.cwd })
    return spawn([process.execPath, f.child, mode, f.calls], options)
  }) as typeof Bun.spawn)
  cleanups.push(() => mock.mockRestore())
  return seen
}

test("fixed OpenSSH argv and clean environment carry only a stdin business request; valid ACK binds through the existing port", async () => {
  const f = fixture(), seen = fakeSsh(f, "ok"), transport = sshStdioTransport(f.config)
  const port = createRecoveryJournal({ journalId: f.config.journalId, transport })
  expect((await Effect.runPromise(port.currentAuthority("scope-1"))).fence.ownerId).toBe("worker-1")
  const input = f.request()
  if (input.method !== "reserveDispatch") throw new Error("fixture")
  expect((await Effect.runPromise(port.reserveDispatch(input.intent))).intent).toEqual(input.intent)
  expect(seen).toHaveLength(2)
  const call = seen[0]
  expect(call.argv[0]).toBe("/usr/bin/ssh")
  expect(call.argv.slice(1, 4)).toEqual(["-F", "none", "-T"])
  for (const option of ["BatchMode=yes", "StrictHostKeyChecking=yes", "GlobalKnownHostsFile=/dev/null", "IdentityAgent=none", "ControlPath=none",
    "ProxyCommand=none", "ProxyJump=none", "ClearAllForwardings=yes", "PermitLocalCommand=no", "CertificateFile=none", "UpdateHostKeys=no", "ConnectionAttempts=1"])
    expect(call.argv).toContain(option)
  expect(call.argv.slice(-3)).toEqual(["--", "journal.example.invalid", SSH_REQUEST_SELECTOR])
  expect(call.argv).not.toContain("--owner-id")
  expect(call.argv).not.toContain("admin")
  expect(call.env).toEqual({ PATH: "/usr/bin:/bin", LANG: "C", SSH_ASKPASS_REQUIRE: "never" })
  expect(call.cwd).toBe("/")
  // OpenSSH -G only expands this explicit configuration; it does not connect or
  // load private keys. This checks installed OpenSSH accepts the fixed options.
  const effective = spawnSync(call.argv[0], ["-G", ...call.argv.slice(1)], { env: call.env, encoding: "utf8", timeout: 3000, maxBuffer: 128 * 1024 })
  expect(effective.status, effective.stderr).toBe(0)
  expect(effective.stdout).toContain("stricthostkeychecking true")
  expect(effective.stdout).toContain("batchmode yes")
  expect(effective.stdout).toContain("identityagent none")
  expect(effective.stdout.split("\n").filter(line => line.startsWith("certificatefile "))).toEqual(["certificatefile none"])
  expect(effective.stdout.split("\n").filter(line => line.startsWith("identityfile "))).toEqual([`identityfile ${f.config.identity.path}`])
})

test.each(["exit-2", "exit-255", "sigkill", "truncated", "two-responses", "stdout-flood", "stderr-flood", "wrong-request", "wrong-journal", "changed-intent", "changed-ref", "false-success"])(
  "%s cannot deliver a permit, and exactly one real local child is invoked", async mode => {
    const f = fixture(), seen = fakeSsh(f, mode), transport = sshStdioTransport(f.config)
    await expect(transport(f.request())).rejects.toThrow()
    expect(seen).toHaveLength(1)
    expect(readFileSync(f.calls, "utf8")).toBe("called\n")
  })

test("timeout is bounded and never retried", async () => {
  const f = fixture(), seen = fakeSsh(f, "timeout")
  const transport = sshStdioTransport({ ...f.config, timeoutMs: 100 })
  const began = Date.now()
  await expect(transport(f.request())).rejects.toThrow("transport_timeout")
  expect(Date.now() - began).toBeLessThan(2500)
  expect(seen).toHaveLength(1)
})

test("server authority for a different credential-bound owner is refused", async () => {
  const f = fixture(), seen = fakeSsh(f, "wrong-owner"), transport = sshStdioTransport(f.config)
  await expect(transport({ schemaVersion: "recovery-journal-request/1", requestId: "authority-1", journalId: "journal-1", method: "currentAuthority", scopeId: "scope-1" })).rejects.toThrow("invalid_authority_proof")
  expect(seen).toHaveLength(1)
})

test("configuration and stdin cannot override host/owner/admin/command; input is frozen at construction", async () => {
  const f = fixture(), seen = fakeSsh(f, "ok")
  expect(() => sshStdioTransport({ ...f.config, knownHosts: { ...f.config.knownHosts, path: f.config.identity.path } })).toThrow("ssh_public_private_reference_alias")
  for (const patch of [{ host: "-oProxyCommand=id" }, { host: "host;id" }, { user: "user name" }, { port: 0 }, { timeoutMs: 0 },
    { forcedCommand: { ...f.config.forcedCommand, selector: "admin" } }, { command: "id" }, { sshPath: "/tmp/ssh" }, { env: { SSH_AUTH_SOCK: "other" } }])
    expect(() => sshStdioTransport({ ...f.config, ...patch } as any)).toThrow()
  const transport = sshStdioTransport(f.config)
  ;(f.config as any).host = "substituted.example.invalid"
  const request = f.request()
  for (const patch of [{ method: "advanceFence" }, { journalId: "other" }, { command: "id" }, { ownerId: "other" }])
    await expect(transport({ ...request, ...patch } as any)).rejects.toThrow()
  if (request.method !== "reserveDispatch") throw new Error("fixture")
  await expect(transport({ ...request, intent: { ...request.intent, fence: { ...request.intent.fence, ownerId: "other" } } })).rejects.toThrow("ssh_request_binding_mismatch")
  expect(seen).toHaveLength(0)
  await transport(request)
  expect(seen[0].argv.at(-2)).toBe("journal.example.invalid")
})

test("pinned public host keys, protected identity metadata and path grammar are rechecked before any child", async () => {
  const f = fixture(), seen = fakeSsh(f, "ok")
  expect(() => sshStdioTransport({ ...f.config, knownHosts: { ...f.config.knownHosts, digest: digestOf("other") } })).toThrow()
  const link = join(f.root, "identity-link"); symlinkSync(f.config.identity.path, link)
  expect(() => sshStdioTransport({ ...f.config, identity: { ...f.config.identity, path: link } })).toThrow()
  const expanded = join(f.root, "identity%h"); writeFileSync(expanded, "synthetic", { mode: 0o600 })
  expect(() => sshStdioTransport({ ...f.config, identity: { ...f.config.identity, path: expanded } })).toThrow()
  const transport = sshStdioTransport(f.config)
  chmodSync(f.config.identity.path, 0o644)
  await expect(transport(f.request())).rejects.toThrow("ssh_identity_attributes_invalid")
  chmodSync(f.config.identity.path, 0o600)
  const second = sshStdioTransport(f.config)
  writeFileSync(f.config.knownHosts.path, "changed public host keys\n")
  await expect(second(f.request())).rejects.toThrow()
  expect(seen).toHaveLength(0)
})
