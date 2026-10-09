import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

const fixture = join(import.meta.dir, "fixtures/extra-stdio-sqlite.ts")
const modes = ["no-extra", "extra-end", "extra-destroy", "extra-retained"] as const
const rounds = 20

// A native guarded-FD fault must terminate only this synthetic subprocess,
// never the test runner. This uses no model, device, network or project DB.
for (const mode of modes) test.skipIf(process.platform !== "darwin")(`extra stdio and held SQLite WAL survive GC (${mode})`, async () => {
  const root = mkdtempSync("/private/tmp/loopit-stdio-regression-")
  const markers = () => readdirSync(root).filter(name => /^child-\d+\.json$/.test(name))
    .map(name => JSON.parse(readFileSync(join(root, name), "utf8")) as { state: string })
  let safeToRemove = false
  try {
    const result = spawnSync(process.execPath, [fixture, mode, root, String(rounds)], {
      cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 20_000, maxBuffer: 65_536, killSignal: "SIGKILL",
    })
    // Every grandchild has its own 15-second lifetime. A failed parent cannot
    // leave an unbounded child, and no recovered marker PID is ever signalled.
    const until = Date.now() + 16_000
    if (result.error || result.signal || result.status !== 0) await Bun.sleep(15_500)
    while (markers().some(marker => marker.state !== "exited") && Date.now() < until) await Bun.sleep(50)
    safeToRemove = markers().every(marker => marker.state === "exited")
    expect(safeToRemove, `synthetic child cleanup unconfirmed; retained ${root}`).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.signal, result.stderr).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    expect(markers()).toHaveLength(rounds)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "completed-without-observed-crash", mode, rounds })
    const events = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))
    expect(events.filter(event => typeof event.iteration === "number")).toHaveLength(rounds)
    expect(events.at(-1)).toMatchObject({ phase: "completed", mode })
  } finally {
    if (safeToRemove) rmSync(root, { recursive: true, force: true })
  }
}, 45_000)
