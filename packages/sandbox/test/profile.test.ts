import { describe, expect, test } from "bun:test"
import { SandboxPolicyError, Seatbelt, type SandboxPolicy } from "../src"

const policy = (patch: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  workdir: "/private/var/loopit/worker/attempts/att-1",
  writable: ["/tmp/loopit-att-1"],
  denyRead: ["/Users/operator"],
  network: { mode: "none" },
  env: { PATH: "/usr/bin:/bin", HOME: "/private/var/loopit/worker/attempts/att-1/home" },
  ...patch,
})

describe("seatbelt profile", () => {
  test("denies by default, writes only to the attempt paths, passes paths as parameters", () => {
    const { text, params } = Seatbelt.profile(policy())
    expect(text.split("\n").slice(0, 2)).toEqual(["(version 1)", "(deny default)"])
    expect(text).toContain('(allow file-write* (subpath (param "WORKDIR")) (subpath (param "WRITABLE_0")))')
    expect(text).toContain('(deny file-read* (subpath (param "DENY_0")))')
    expect(params).toEqual({
      WORKDIR: "/private/var/loopit/worker/attempts/att-1",
      WRITABLE_0: "/private/tmp/loopit-att-1",
      DENY_0: "/Users/operator",
    })
    // Paths never appear in the profile text itself, so they cannot inject rules.
    expect(text).not.toContain("/Users/operator")
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
    expect(() => Seatbelt.profile(policy({ writable: ["/Users/operator/cache"] }))).toThrow(SandboxPolicyError)
    expect(() => Seatbelt.profile(policy({ network: { mode: "proxy", port: 0 } }))).toThrow(SandboxPolicyError)
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
