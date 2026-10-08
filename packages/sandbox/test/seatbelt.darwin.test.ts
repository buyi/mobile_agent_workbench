import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { type SandboxPolicy, Seatbelt } from "../src"

// Sandbox conformance (M0-A07 / S14) on a real macOS host. Every negative case first
// proves the action works without the sandbox, so a denial is attributable to Seatbelt
// and not to a missing tool or network. On other platforms these cases are notRun.

const mac = process.platform === "darwin"
const backend = Seatbelt.seatbelt()
let root = ""
let policy: SandboxPolicy
const servers: Array<{ stop: () => void }> = []

const run = (argv: string[], sandboxed: boolean, p: SandboxPolicy = policy) => {
  const cmd = sandboxed ? backend.command(argv, p) : { argv, env: p.env }
  const out = Bun.spawnSync([...cmd.argv], { env: { ...cmd.env }, cwd: p.workdir })
  return { code: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() }
}

/** The action must succeed outside the sandbox and fail inside it. */
const expectBlocked = (argv: string[], p: SandboxPolicy = policy) => {
  const baseline = run(argv, false, p)
  expect(baseline.code, `baseline must succeed to make the denial meaningful: ${baseline.stderr}`).toBe(0)
  expect(run(argv, true, p).code).not.toBe(0)
}

const listen = (port = 0) => {
  const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } })
  servers.push(server)
  return server.port
}

beforeAll(() => {
  if (!mac) return
  root = realpathSync(mkdtempSync(join(tmpdir(), "loopit-sbx-")))
  for (const dir of ["work", "outside", "secret"]) mkdirSync(join(root, dir))
  writeFileSync(join(root, "secret/token.txt"), "s3cr3t")
  symlinkSync(join(root, "outside"), join(root, "work/escape"))
  policy = {
    workdir: join(root, "work"),
    writable: [],
    denyRead: [join(root, "secret")],
    network: { mode: "none" },
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: join(root, "work"), TMPDIR: join(root, "work") },
  }
})

afterAll(() => {
  for (const server of servers) server.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!mac)("seatbelt conformance", () => {
  test("probe reports an available backend", async () => {
    const caps = await backend.probe()
    expect(caps.available, caps.notes.join("; ")).toBe(true)
  })

  test("writes inside the workdir succeed", () => {
    expect(run(["/bin/sh", "-c", `echo ok > ${policy.workdir}/inside.txt`], true).code).toBe(0)
    expect(existsSync(join(policy.workdir, "inside.txt"))).toBe(true)
  })

  test("writes outside the workdir are denied", () => {
    const target = join(root, "outside/direct.txt")
    expect(run(["/bin/sh", "-c", `echo x > ${target}`], true).code).not.toBe(0)
    expect(existsSync(target)).toBe(false)
  })

  test("grandchildren inherit the sandbox", () => {
    const target = join(root, "outside/grandchild.txt")
    run(["/bin/sh", "-c", `/bin/sh -c 'echo x > ${target}'`], true)
    expect(existsSync(target)).toBe(false)
  })

  test("a symlink inside the workdir cannot be used to write outside", () => {
    const target = join(root, "outside/via-link.txt")
    run(["/bin/sh", "-c", `echo x > ${policy.workdir}/escape/via-link.txt`], true)
    expect(existsSync(target)).toBe(false)
  })

  test("denied paths cannot be read or listed", () => {
    expectBlocked(["/bin/cat", join(root, "secret/token.txt")])
    expectBlocked(["/bin/ls", join(root, "secret")])
  })

  test("network none: local TCP and the internet are unreachable", () => {
    expectBlocked(["/usr/bin/nc", "-z", "-w", "3", "127.0.0.1", String(listen())])
    expectBlocked(["/usr/bin/nc", "-z", "-w", "5", "1.1.1.1", "443"])
  })

  test("network proxy: only the proxy port is reachable", () => {
    const proxy = listen()
    const other = listen()
    const proxied: SandboxPolicy = { ...policy, network: { mode: "proxy", port: proxy } }
    expect(run(["/usr/bin/nc", "-z", "-w", "3", "localhost", String(proxy)], true, proxied).code).toBe(0)
    expectBlocked(["/usr/bin/nc", "-z", "-w", "3", "127.0.0.1", String(other)], proxied)
    expectBlocked(["/usr/bin/nc", "-z", "-w", "5", "1.1.1.1", "443"], proxied)
  })

  test("the Worker environment does not leak into the sandbox", () => {
    process.env.LOOPIT_LEAK_PROBE = "leaked"
    const out = run(["/usr/bin/env"], true)
    expect(out.code).toBe(0)
    expect(out.stdout).not.toContain("LOOPIT_LEAK_PROBE")
  })

  test("keychain services are unreachable", () => {
    expectBlocked(["/usr/bin/security", "list-keychains"])
  })
})

const operatorHome = process.env.LOOPIT_OPERATOR_HOME
const dedicated = mac && userInfo().username === (process.env.LOOPIT_WORKER_USER ?? Seatbelt.DEFAULT_WORKER_USER)

describe.skipIf(!dedicated || !operatorHome)("dedicated account isolation", () => {
  test("the operator's keychains and ssh keys are unreadable even without Seatbelt", () => {
    for (const path of ["Library/Keychains", ".ssh"]) {
      const out = Bun.spawnSync(["/bin/ls", join(operatorHome!, path)])
      expect(out.exitCode, `${path} must be unreadable for ${userInfo().username}`).not.toBe(0)
    }
  })
})
