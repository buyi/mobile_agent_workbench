import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { SandboxPolicyError, Seatbelt, type SandboxPolicy } from "../src"
import { inspectWorkerAccount } from "../src/worker-account"

const root = realpathSync(mkdtempSync(join(tmpdir(), "loopit-profile-")))
for (const dir of ["work", "cache", "operator", "operator/cache"]) mkdirSync(join(root, dir))
afterAll(() => rmSync(root, { force: true, recursive: true }))

const policy = (patch: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  workdir: join(root, "work"),
  writable: [join(root, "cache")],
  denyRead: [join(root, "operator")],
  network: { mode: "none" },
  env: { PATH: "/usr/bin:/bin", HOME: join(root, "work") },
  ...patch,
})

describe("seatbelt profile", () => {
  test("denies by default, writes only to the attempt paths, passes paths as parameters", () => {
    const { text, params } = Seatbelt.profile(policy())
    expect(text.split("\n").slice(0, 2)).toEqual(["(version 1)", "(deny default)"])
    expect(text).toContain('(allow file-write* (subpath (param "WORKDIR")) (subpath (param "WRITABLE_0")))')
    expect(text).toContain('(deny file-read* (subpath (param "DENY_0")))')
    expect(params).toEqual({
      WORKDIR: join(root, "work"),
      WRITABLE_0: join(root, "cache"),
      DENY_0: join(root, "operator"),
    })
    // Paths never appear in the profile text itself, so they cannot inject rules.
    expect(text).not.toContain(join(root, "operator"))
  })

  test("the read denial comes after the broad read allowance", () => {
    const { text } = Seatbelt.profile(policy())
    expect(text.indexOf("(deny file-read*")).toBeGreaterThan(text.indexOf("(allow file-read*)"))
  })

  test("network: none opens nothing, proxy opens only the localhost proxy port", () => {
    expect(Seatbelt.profile(policy()).text).not.toContain("network")
    const proxied = Seatbelt.profile(policy({ network: { mode: "proxy", port: 18080 } })).text
    expect(proxied.match(/network/g)?.length).toBe(1)
    expect(proxied).toContain('(allow network-outbound (remote ip "localhost:18080"))')
  })

  test("keychain and direct DNS services are not reachable", () => {
    const { text } = Seatbelt.profile(policy())
    expect(text).not.toContain("SecurityServer")
    expect(text).not.toContain("securityd")
    expect(text).not.toContain("dnssd")
  })

  test("rejects relative, traversing or overlapping paths and bad ports", () => {
    expect(() => Seatbelt.profile(policy({ workdir: "work" }))).toThrow(SandboxPolicyError)
    expect(() => Seatbelt.profile(policy({ writable: ["/tmp/a/../b"] }))).toThrow(SandboxPolicyError)
    expect(() => Seatbelt.profile(policy({ writable: [join(root, "operator/cache")] }))).toThrow(SandboxPolicyError)
    expect(() => Seatbelt.profile(policy({ network: { mode: "proxy", port: 0 } }))).toThrow(SandboxPolicyError)
  })

  test("resolves real symlinks before checking overlap and rejects missing or non-directory roots", () => {
    const alias = join(root, "operator-alias")
    symlinkSync(join(root, "operator"), alias)
    expect(() => Seatbelt.profile(policy({ writable: [join(alias, "cache")] }))).toThrow(SandboxPolicyError)
    expect(() => Seatbelt.profile(policy({ denyRead: [root] }))).toThrow(SandboxPolicyError)
    expect(() => Seatbelt.profile(policy({ writable: [join(root, "missing")] }))).toThrow(SandboxPolicyError)
    const file = join(root, "file")
    writeFileSync(file, "x")
    expect(() => Seatbelt.profile(policy({ workdir: file }))).toThrow(SandboxPolicyError)
    const workAlias = join(root, "work-alias")
    symlinkSync(join(root, "work"), workAlias)
    expect(Seatbelt.profile(policy({ workdir: workAlias })).params.WORKDIR).toBe(join(root, "work"))
    expect(() => Seatbelt.profile(policy({ writable: [join(root, "operator") + "/."] }))).toThrow(SandboxPolicyError)
  })

  test("matching a configured username does not certify a dedicated account", async () => {
    const result = await inspectWorkerAccount(userInfo().username)
    // The ordinary operator/root used by unit tests is not a configured service account.
    if (userInfo().uid === 0 || userInfo().uid >= 500 || process.platform !== "darwin") expect(result.valid).toBe(false)
    expect(result.notes.length).toBeGreaterThan(0)
  })

  test("command uses only the given environment and records a stable profile digest", () => {
    const backend = Seatbelt.seatbelt({ workerUser: "loopit-worker" })
    const a = backend.command(["/bin/sh", "-c", "true"], policy())
    expect(a.argv[0]).toBe(Seatbelt.SANDBOX_EXEC)
    expect(a.argv.slice(-3)).toEqual(["/bin/sh", "-c", "true"])
    expect(a.env).toEqual(policy().env)
    expect(backend.command(["/bin/sh"], policy()).profileDigest).toBe(a.profileDigest)
    expect(backend.command(["/bin/sh"], policy({ denyRead: [] })).profileDigest).not.toBe(a.profileDigest)
    expect(() => backend.command(["-c"], policy())).toThrow(SandboxPolicyError)
    expect(() => backend.command(["/bin/sh"], policy({ env: {} }))).toThrow(SandboxPolicyError)
  })
})
