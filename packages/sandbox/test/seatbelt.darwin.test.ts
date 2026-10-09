import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type SandboxPolicy, Seatbelt } from "../src"
import { runProcess, type ProcessResult } from "../src/process"
import { publicProbeIPv4 } from "./public-network"

let publicIPv4: string | undefined
try { publicIPv4 = publicProbeIPv4(process.env.LOOPIT_SANDBOX_PUBLIC_IPV4) }
catch (error) { console.warn(`blocked: public TCP endpoint configuration: ${String(error)}`) }

const backend = Seatbelt.seatbelt()
const caps = await backend.probe()
const ready = process.platform === "darwin" && caps.available
if (!ready) console.warn(`blocked: Seatbelt conformance: ${caps.notes.join("; ")}`)
const root = ready ? realpathSync(mkdtempSync(join(tmpdir(), "loopit-sbx-"))) : ""
const servers: Array<{ stop: () => void }> = []
const okay = (out: ProcessResult | undefined) => !!out && out.code === 0 && !out.timedOut && !out.error
const details = (out: ProcessResult) => JSON.stringify(out)
if (ready) {
  for (const dir of ["work", "outside", "secret"]) mkdirSync(join(root, dir))
  writeFileSync(join(root, "secret/token.txt"), "s3cr3t")
  symlinkSync(join(root, "outside"), join(root, "work/escape"))
}
const policy: SandboxPolicy = {
  workdir: join(root, "work"), writable: [], denyRead: [join(root, "secret")], network: { mode: "none" },
  env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: join(root, "work"), TMPDIR: join(root, "work") },
}
const run = (argv: string[], sandboxed: boolean, p: SandboxPolicy = policy) => {
  const cmd = sandboxed ? backend.command(argv, p) : { argv, env: p.env }
  return runProcess(cmd.argv, { env: cmd.env, cwd: p.workdir, timeoutMs: 2000 })
}
const expectDenied = (out: ProcessResult) => {
  expect(out.timedOut, "timeout does not prove a sandbox denial").toBe(false)
  expect(out.error).toBeUndefined()
  expect(out.signal, "signal/crash does not prove a sandbox denial").toBeNull()
  expect(out.code, details(out)).not.toBe(0)
}
const listen = () => {
  if (!ready) return undefined
  try {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
    servers.push(server)
    return server.port
  } catch (error) { console.warn(`blocked: controlled TCP listener unavailable: ${String(error)}`); return undefined }
}
const connect = (host: string, port: number) => ["/usr/bin/nc", "-4", "-z", "-G", "1", "-w", "1", host, String(port)]
afterAll(() => {
  for (const server of servers) server.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

interface NegativeCase {
  name: string
  argv: string[]
  policy?: SandboxPolicy
  prerequisite?: boolean
  cleanup?: () => void
  check?: () => void
  publicIPv4?: string
}
const negatives: NegativeCase[] = []
for (const kind of ["direct", "grandchild", "symlink"] as const) {
  const target = join(root, "outside", `${kind}.txt`)
  const path = kind === "symlink" ? join(policy.workdir, "escape", `${kind}.txt`) : target
  const argv = kind === "grandchild"
    ? ["/bin/sh", "-c", '/bin/sh -c \'echo x > "$1"\' sh "$1"', "sh", path]
    : ["/bin/sh", "-c", 'echo x > "$1"', "sh", path]
  negatives.push({ name: `${kind}: writes outside workdir denied`, argv,
    cleanup: () => rmSync(target, { force: true }), check: () => expect(existsSync(target)).toBe(false) })
}
negatives.push(
  { name: "denied file cannot be read", argv: ["/bin/cat", join(root, "secret/token.txt")] },
  { name: "denied directory cannot be listed", argv: ["/bin/ls", join(root, "secret")] },
  { name: "keychain services are unreachable", argv: ["/usr/bin/security", "list-keychains"] },
  { name: "direct CoreSimulator service access is denied", argv: ["/usr/bin/xcrun", "simctl", "list", "devices", "-j"] },
)
const local = listen(), proxy = listen(), other = listen()
const proxied: SandboxPolicy = { ...policy, network: { mode: "proxy", port: proxy ?? 65534 } }
negatives.push(
  { name: "network none: controlled local TCP denied", argv: connect("127.0.0.1", local ?? 0), prerequisite: !!local },
  { name: "network proxy: other controlled local port denied", argv: connect("127.0.0.1", other ?? 0), policy: proxied, prerequisite: !!proxy && !!other },
  // Passing local TCP cases cannot substitute for the public network baseline.
  { name: `public TCP none: ${publicIPv4 ?? "invalid-config"}:443 requires reachable baseline`, argv: connect(publicIPv4 ?? "", 443), prerequisite: !!publicIPv4, publicIPv4 },
  { name: `public TCP proxy: ${publicIPv4 ?? "invalid-config"}:443 requires reachable baseline`, argv: connect(publicIPv4 ?? "", 443), policy: proxied, prerequisite: !!publicIPv4, publicIPv4 },
)
// Baselines run outside test assertions so environmental inability becomes skipped
// JUnit/notRun. Never call a timeout, absent tool, missing fixture, or crash a denial.
const measured = await Promise.all(negatives.map(async (entry) => {
  const baseline = ready && entry.prerequisite !== false ? await run(entry.argv, false, entry.policy) : undefined
  if (entry.publicIPv4) console.log(JSON.stringify({ type: "sandbox.publicTcpProbe", phase: "baseline", case: entry.name,
    ip: entry.publicIPv4, port: 443, code: baseline?.code ?? null, timedOut: baseline?.timedOut ?? false,
    outcome: okay(baseline) ? "reachable" : "notRun" }))
  entry.cleanup?.()
  if (ready && !okay(baseline)) console.warn(`blocked: ${entry.name}: baseline unavailable${baseline ? ` ${details(baseline)}` : ""}`)
  return { ...entry, baseline }
}))
const proxyBaseline = ready && proxy ? await run(connect("127.0.0.1", proxy), false, proxied) : undefined
if (ready && !okay(proxyBaseline)) console.warn("blocked: controlled proxy allow baseline unavailable")

describe.skipIf(!ready)("seatbelt conformance", () => {
  test("writes inside the workdir succeed", async () => {
    const out = await run(["/bin/sh", "-c", 'echo ok > "$1"', "sh", join(policy.workdir, "inside.txt")], true)
    expect(okay(out), details(out)).toBe(true)
    expect(existsSync(join(policy.workdir, "inside.txt"))).toBe(true)
  })
  for (const entry of measured) {
    test.skipIf(!okay(entry.baseline))(entry.name, async () => {
      const confined = await run(entry.argv, true, entry.policy)
      if (entry.publicIPv4) console.log(JSON.stringify({ type: "sandbox.publicTcpProbe", phase: "sandbox", case: entry.name,
        ip: entry.publicIPv4, port: 443, code: confined.code, timedOut: confined.timedOut, signal: confined.signal }))
      expectDenied(confined)
      entry.check?.()
    })
  }
  test.skipIf(!okay(proxyBaseline))("network proxy: controlled proxy port is reachable", async () => {
    const out = await run(connect("127.0.0.1", proxy!), true, proxied)
    expect(okay(out), details(out)).toBe(true)
  })
  test("the Worker environment does not leak into the sandbox", async () => {
    const previous = process.env.LOOPIT_LEAK_PROBE
    process.env.LOOPIT_LEAK_PROBE = "leaked"
    try {
      const out = await run(["/usr/bin/env"], true)
      expect(okay(out), details(out)).toBe(true)
      expect(out.stdout).not.toContain("LOOPIT_LEAK_PROBE")
    } finally {
      if (previous === undefined) delete process.env.LOOPIT_LEAK_PROBE
      else process.env.LOOPIT_LEAK_PROBE = previous
    }
  })
})

// Explicitly supplied non-secret fixtures only. Provisioning must establish the
// independent owner-side baseline. Do not grant Worker general sudo to enable this:
// unavailable noninteractive baseline permissions correctly leave the case notRun.
for (const kind of ["OPERATOR", "SIGNER"] as const) {
  const owner = process.env[`LOOPIT_${kind}_USER`] ?? (kind === "SIGNER" ? "loopit-signer" : undefined)
  const file = process.env[`LOOPIT_${kind}_PROBE_FILE`]
  const safe = owner && /^[a-z_][a-z0-9_-]*$/.test(owner) && file?.startsWith("/")
  const identity = ready && caps.dedicatedUser && safe
    ? await runProcess(["/usr/bin/sudo", "-n", "-u", owner!, "/usr/bin/id", "-u"], { timeoutMs: 2000 }) : undefined
  const baseline = identity && okay(identity) && Number(identity.stdout.trim()) !== process.getuid?.()
    ? await runProcess(["/usr/bin/sudo", "-n", "-u", owner!, "/bin/cat", file!], { timeoutMs: 2000 }) : undefined
  const established = okay(baseline)
  if (!established) console.warn(`blocked: ${kind.toLowerCase()} account isolation needs verified Worker and successful owner-side read of LOOPIT_${kind}_PROBE_FILE`)
  test.skipIf(!established)(`${kind.toLowerCase()} fixture unreadable to Worker without Seatbelt after owner baseline`, async () => {
    expectDenied(await runProcess(["/bin/cat", file!], { timeoutMs: 2000 }))
  })
}
