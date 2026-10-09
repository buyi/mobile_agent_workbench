import { expect, test } from "bun:test"
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("fresh setup installs a real tsc command usable through bun run typecheck", () => {
  const root = mkdtempSync(join(tmpdir(), "loopit-setup-test-"))
  try {
    mkdirSync(join(root, "script"))
    mkdirSync(join(root, "vendor"))
    symlinkSync(realpathSync(join(import.meta.dir, "../../vendor/opencode")), join(root, "vendor/opencode"))
    copyFileSync(join(import.meta.dir, "../setup.ts"), join(root, "script/setup.ts"))
    copyFileSync(join(import.meta.dir, "../../package.json"), join(root, "package.json"))
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { skipLibCheck: true, types: [] }, files: ["example.ts"] }))
    writeFileSync(join(root, "example.ts"), "const value: number = 1;")
    const env = { ...process.env, XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state") }
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env })
    expect(run("script/setup.ts").exitCode).toBe(0)
    expect(lstatSync(join(root, "node_modules/.bin/tsc")).isSymbolicLink()).toBe(true)
    expect(run("run", "typecheck").exitCode).toBe(0)
    // Prove the installed binary actually checks types, and repeated setup is safe.
    writeFileSync(join(root, "example.ts"), 'const value: number = "incorrect";')
    expect(run("script/setup.ts").exitCode).toBe(0)
    const failure = run("run", "typecheck")
    expect(failure.exitCode).not.toBe(0)
    expect(failure.stdout.toString()).toContain("TS2322")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("wrong Bun version is refused before dependency checks or existing link changes", () => {
  const root = mkdtempSync(join(tmpdir(), "loopit-setup-version-test-"))
  try {
    mkdirSync(join(root, "script"))
    mkdirSync(join(root, "node_modules"))
    copyFileSync(join(import.meta.dir, "../setup.ts"), join(root, "script/setup.ts"))
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "bun@0.0.0" }))
    writeFileSync(join(root, "existing-target"), "preserve existing dependency")
    symlinkSync("../existing-target", join(root, "node_modules/effect"))
    // Deliberately no vendor dependencies: the version check must run first.
    const result = Bun.spawnSync([process.execPath, "script/setup.ts"], {
      cwd: root, stdout: "pipe", stderr: "pipe",
      env: { PATH: "/usr/bin:/bin", HOME: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    })
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toString()).toContain(`workbench Bun version mismatch: expected 0.0.0, received ${Bun.version}`)
    expect(result.stdout.toString()).toBe("")
    expect(readdirSync(join(root, "node_modules"))).toEqual(["effect"])
    expect(readlinkSync(join(root, "node_modules/effect"))).toBe("../existing-target")
    expect(readFileSync(join(root, "existing-target"), "utf8")).toBe("preserve existing dependency")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
