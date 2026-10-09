import { expect, test } from "bun:test"
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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
