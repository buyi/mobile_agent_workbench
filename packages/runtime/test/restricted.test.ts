import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { KERNEL_IDENTITY_PROBE, assertKernelIdentity, assertEffectiveRestrictedConfig, remainingExecutionMs, restrictedConfigBinding, restrictedConfigDigest, restrictedNativeConfig,
  restrictedCommand, restrictedPermissions, resolveAccessEnvironment, redactCapturedOutput, validateRestrictedLayout, type RestrictedConfig } from "../src"

const digest = "sha256:" + "a".repeat(64)
const fixture = (): RestrictedConfig => ({
  readPaths: ["src/feature.ts", "src/types.ts"], editPaths: ["src/feature.ts"], agent: { name: "worker", steps: 3 },
  model: { provider: "openai", model: "gpt-6.1-sol", variant: "low" }, catalog: { path: "/fixture/catalog.json", digest },
  oauthAccess: async () => ({ access: "synthetic-access-token", expiresAt: Date.now() + 300_000 }),
  isolation: { runtimeDirectory: "/fixture/child", identityRuntime: { path: "/fixture/bun", digest }, admission: { scopeId: "fixture-scope", generation: 1 }, childIdentity: { uid: 420, gid: 420 },
    launcher: { argvPrefix: ["/usr/bin/python3", "/fixture/wrapper.py", "--uid", "420", "--gid", "420", "--"], wrapperPath: "/fixture/wrapper.py", wrapperDigest: digest },
    denyRead: ["/Users/operator"], proxyPort: 7897 },
})

describe("restricted execution host configuration (no privileged/model calls)", () => {
  test("exact file permissions deny everything else and reject wildcard, traversal and unregistered edits", () => {
    const config = fixture(), permission = restrictedPermissions(config)
    expect(permission["*"]).toBe("deny")
    expect(permission.edit as Record<string, string>).toEqual({ "*": "deny", "src/feature.ts": "allow" })
    for (const path of ["../secret", "/etc/passwd", "src/*", "src/?.ts", "src/[a].ts", "src/./a.ts", "src//a.ts", "src/!a.ts", "src/\\a.ts"])
      expect(() => restrictedPermissions({ readPaths: [path], editPaths: [path] })).toThrow()
    expect(() => restrictedPermissions({ readPaths: ["read.ts"], editPaths: ["else.ts"] })).toThrow("subset")
    expect(() => restrictedPermissions({ readPaths: ["a", "a"], editPaths: ["a"] })).toThrow("duplicate")
  })
  test("pinned native matcher allows the registered file but denies directory navigation and external reads", () => {
    const directory = mkdtempSync(join(tmpdir(), "loopit-native-permission-"))
    try {
      const config = restrictedNativeConfig({ ...fixture(), readPaths: ["sumEvenThrough.ts"], editPaths: ["sumEvenThrough.ts"] })
      // Exercise the pinned engine itself: tools normalize absolute file paths
      // relative to instance.worktree before requesting read/edit permission.
      // A child keeps upstream module initialization out of the test process.
      const modulePath = fileURLToPath(new URL("../../../vendor/opencode/packages/opencode/src/permission/index.ts", import.meta.url))
      const program = `
        const { evaluate, fromConfig, disabled } = await import(process.argv[1]);
        const { relative } = await import("node:path");
        const config = JSON.parse(process.argv[2]);
        const rules = [
          ...fromConfig({ "*": "allow" }),
          ...fromConfig(config.permission),
          ...fromConfig(config.agent.worker.permission),
        ];
        const workspace = "/fixture/workspace";
        const file = relative(workspace, workspace + "/sumEvenThrough.ts");
        console.log(JSON.stringify({
          read: evaluate("read", file, rules).action,
          edit: evaluate("edit", file, rules).action,
          directory: evaluate("read", relative(workspace, workspace), rules).action,
          sibling: evaluate("read", relative(workspace, workspace + "/other.ts"), rules).action,
          nestedSameName: evaluate("edit", relative(workspace, workspace + "/sub/sumEvenThrough.ts"), rules).action,
          external: evaluate("external_directory", "/fixture/public/*", rules).action,
          hidden: [...disabled(["read", "edit", "write", "apply_patch", "bash", "glob", "grep", "task"], rules)],
        }));
      `
      const result = spawnSync(process.execPath, ["--eval", program, modulePath, JSON.stringify(config)], {
        encoding: "utf8", timeout: 5000, maxBuffer: 8192,
        env: { PATH: "/usr/bin:/bin", XDG_CACHE_HOME: join(directory, "cache"), XDG_CONFIG_HOME: join(directory, "config"),
          XDG_DATA_HOME: join(directory, "data"), XDG_STATE_HOME: join(directory, "state") },
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ read: "allow", edit: "allow", directory: "deny", sibling: "deny",
        nestedSameName: "deny", external: "deny", hidden: ["bash", "glob", "grep", "task"] })
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  test("public digest binds all capabilities but never credentials/resolver identity", () => {
    const config = fixture(), original = restrictedConfigDigest(config)
    const rotated = { ...config, oauthAccess: async () => ({ access: "different-access-token", expiresAt: Date.now() + 999_999 }) }
    expect(restrictedConfigDigest(rotated)).toBe(original)
    expect(restrictedConfigBinding(config).permissionDigest).not.toBe(original)
    for (const changed of [
      { ...config, model: { ...config.model, variant: "high" } }, { ...config, agent: { ...config.agent, steps: 4 } },
      { ...config, editPaths: [...config.editPaths, "src/types.ts"] }, { ...config, catalog: { ...config.catalog, digest: "sha256:" + "b".repeat(64) } },
      { ...config, isolation: { ...config.isolation, proxyPort: 8888 } },
      { ...config, isolation: { ...config.isolation, identityRuntime: { path: "/fixture/other-bun", digest } } },
      { ...config, isolation: { ...config.isolation, identityRuntime: { path: "/fixture/bun", digest: "sha256:" + "b".repeat(64) } } },
      { ...config, isolation: { ...config.isolation, admission: { scopeId: "next-scope", generation: 2 } } },
    ]) expect(restrictedConfigDigest(changed)).not.toBe(original)
  })
  test("native effective config probe rejects hidden permission, plugin, model and agent overrides", () => {
    const config = fixture(), native = restrictedNativeConfig(config)
    expect(() => assertEffectiveRestrictedConfig(config, JSON.stringify(native))).not.toThrow()
    for (const changed of [{ ...native, permission: { "*": "allow" } }, { ...native, plugin: ["unregistered"] },
      { ...native, model: "other/model" }, { ...native, agent: { worker: { ...native.agent.worker, steps: 9 } } }])
      expect(() => assertEffectiveRestrictedConfig(config, JSON.stringify(changed))).toThrow("differs")
  })
  test("access-only resolver does not inherit environment or accept refresh/expired credentials; errors redact opaque causes", async () => {
    const config = fixture(), auth = await resolveAccessEnvironment(config, { PATH: "/usr/bin:/bin" })
    const native = JSON.parse(auth.env.OPENCODE_AUTH_CONTENT)
    expect(native.openai.refresh).toBe("")
    expect(native.openai.access).toBe("synthetic-access-token")
    expect(Object.keys(auth.env).sort()).toEqual(["OPENCODE_AUTH_CONTENT", "PATH"])
    await expect(resolveAccessEnvironment({ ...config, oauthAccess: async () => ({ access: "synthetic-access-token", expiresAt: Date.now() + 300_000, refresh: "never" }) }, {})).rejects.toThrow("invalid access-only")
    await expect(resolveAccessEnvironment({ ...config, oauthAccess: async () => ({ access: "synthetic-access-token", expiresAt: Date.now() }) }, {})).rejects.toThrow("invalid access-only")
    await expect(resolveAccessEnvironment({ ...config, oauthAccess: async () => { throw new Error("secret-provider-payload") } }, {})).rejects.toThrow(/^OAuth access-only resolver failed$/)
  })
  test("bounded output redaction spans chunks; incomplete token prefixes are omitted entirely", () => {
    expect(redactCapturedOutput([Buffer.from("before synthetic-"), Buffer.from("access-token after")], "synthetic-access-token", false)).toBe("before [REDACTED] after")
    const partial = redactCapturedOutput([Buffer.from("before synthetic-access")], "synthetic-access-token", true)
    expect(partial).not.toContain("synthetic")
    expect(partial).toContain("omitted")
  })
  test("absolute deadlines cannot renew themselves and reject a fourth repair", () => {
    const now = Date.now(), budget = { deadlineAt: new Date(now + 30_000).toISOString(), repairIndex: 0, maxRepairs: 3 as const }
    expect(remainingExecutionMs(budget, now)).toBe(30_000)
    expect(remainingExecutionMs(budget, now + 29_000)).toBe(1_000)
    expect(() => remainingExecutionMs(budget, now + 30_001)).toThrow("expired")
    expect(() => remainingExecutionMs({ ...budget, repairIndex: 4 }, now)).toThrow()
    expect(() => remainingExecutionMs({ ...budget, deadlineAt: new Date(now + 3_600_001).toISOString() }, now)).toThrow()
  })
  test.skipIf(process.getuid?.() === 0)("unprivileged controller fails closed before any launch", () => {
    expect(() => validateRestrictedLayout(fixture(), "/fixture/controller", "/fixture/workspace", "/fixture/opencode", digest)).toThrow("root controller")
  })
})


test("kernel identity probe rejects inherited privileged groups regardless of directory membership", () => {
  const identity = { uid: 420, euid: 420, gid: 420, egid: 420, kernelGroups: [420], directoryReportedGroups: [420, 12, 61, 701, 100] }
  expect(assertKernelIdentity(JSON.stringify(identity), 420, 420).kernelGroups).toEqual([420])
  for (const changed of [{ ...identity, kernelGroups: [420, 0] }, { ...identity, kernelGroups: [420, 80] }, { ...identity, kernelGroups: [] },
    { ...identity, uid: 0 }, { ...identity, egid: 20 }]) expect(() => assertKernelIdentity(JSON.stringify(changed), 420, 420)).toThrow("kernel identity")
})


test("identity runtime requires a pinned absolute path", () => {
  const config = fixture()
  expect(() => restrictedConfigDigest({ ...config, isolation: { ...config.isolation, identityRuntime: undefined as any } })).toThrow("pinned identity")
  expect(() => restrictedConfigDigest({ ...config, isolation: { ...config.isolation, identityRuntime: { path: "bun", digest } } })).toThrow("pinned identity")
  expect(() => restrictedConfigDigest({ ...config, isolation: { ...config.isolation, identityRuntime: { path: "/fixture/bun", digest: "unknown" } } })).toThrow("pinned identity")
})

test.skipIf(process.platform !== "darwin")("fixed Bun FFI identity probe runs with an ordinary UID and no shim/config inheritance", () => {
  const result = spawnSync(process.execPath, ["--eval", KERNEL_IDENTITY_PROBE], { encoding: "utf8", timeout: 3000,
    env: { PATH: "/usr/bin:/bin" }, maxBuffer: 8192 })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(result.stderr).toBe("")
  const identity = JSON.parse(result.stdout)
  expect(identity.uid).toBe(process.getuid!())
  expect(identity.euid).toBe(process.geteuid!())
  expect(identity.gid).toBe(process.getgid!())
  expect(identity.egid).toBe(process.getegid!())
  expect(Array.isArray(identity.kernelGroups)).toBe(true)
  expect(identity.kernelGroups.every((group: unknown) => typeof group === "number" && Number.isInteger(group) && group >= 0)).toBe(true)
})

test.skipIf(process.platform !== "darwin" || process.env.LOOPIT_RUNTIME_SEATBELT_PROBE !== "1")("Bun kernel identity FFI loads under the actual generated deny-default Seatbelt profile", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopit-identity-seatbelt-")))
  try {
    const state = join(root, "controller"), workspace = join(root, "workspace"), runtime = join(root, "runtime")
    for (const path of [state, workspace, runtime]) mkdirSync(path, { mode: 0o700 })
    const base = fixture(), config = { ...base, isolation: { ...base.isolation, runtimeDirectory: runtime, denyRead: [state] } }
    const command = restrictedCommand(config, state, workspace, [process.execPath, "--eval", KERNEL_IDENTITY_PROBE], {})
    // The identity-drop launcher is covered by the privileged Supervisor probe;
    // this ordinary-UID test executes the unmodified generated OS profile.
    const argv = command.argv.slice(config.isolation.launcher.argvPrefix.length)
    const result = spawnSync(argv[0], argv.slice(1), { cwd: workspace, env: command.env, encoding: "utf8", timeout: 3000, maxBuffer: 8192 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    const identity = JSON.parse(result.stdout)
    expect(identity.uid).toBe(process.getuid!())
    expect(Array.isArray(identity.kernelGroups)).toBe(true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
