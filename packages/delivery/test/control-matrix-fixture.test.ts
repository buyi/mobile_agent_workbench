import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync, existsSync, utimesSync, chownSync, statSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { OpenCodeCli } from "../../runtime/src"
import { controlMatrixFixtureSource } from "../../../script/m0/control-matrix-fixture"
import { readFreshFixtureReceipt } from "../../../script/m0/control-matrix-receipt"
import { setup, until, withWorker } from "./worker-fixture"
import { cmd, exec, goal } from "./helpers"

test("deployed fixture protocol runs through real local adapter without private Supervisor environment", async () => {
  const f = setup(), source = controlMatrixFixtureSource(process.execPath, { uid: process.getuid!(), gid: process.getgid!() })
  // macOS /tmp may have wheel GID0; new files inherit the containing directory's
  // group. Match the deployed provisioned candidate UID/GID explicitly instead
  // of weakening the production receipt's dedicated-identity checks.
  chownSync(f.launch.workingDirectory, process.getuid!(), process.getgid!())
  expect(statSync(f.launch.workingDirectory).gid).toBe(process.getgid!())
  writeFileSync(f.cli.executable, source)
  const cli = { ...f.cli, executableDigest: `sha256:${createHash("sha256").update(source).digest("hex")}` }
  f.launch.runtime.sourceDigest = cli.executableDigest
  const adapter = new OpenCodeCli(cli)
  const notBefore = Date.now()
  await withWorker(f.file, { adapter, launch: () => f.launch }, (worker, delivery) => Effect.gen(function* () {
    yield* exec(delivery, cmd.create({ goal: goal({ objective: "fixed no-model child" }) })); yield* exec(delivery, cmd.start(1, "run-1")); yield* worker.drain()
    const record = (yield* worker.get("run-1"))!
    try {
      yield* Effect.promise(() => until(() => { const observed = adapter.inspect(record.handle); return !!observed.pid && existsSync(join(f.launch.workingDirectory, `receipt-${observed.pid}.json`)) }))
      const observed = adapter.inspect(record.handle), receipt = JSON.parse(readFileSync(join(f.launch.workingDirectory, `receipt-${observed.pid}.json`), "utf8"))
      expect(receipt).toEqual({ uid: process.getuid!(), gid: process.getgid!(), pid: observed.pid, taskId: "task-1", fixture: true, modelCalls: 0 })
      expect(observed.status).toBe("running")
      expect(source).not.toContain("LOOPIT_SCOPE_ID")
      expect(source).not.toContain("LOOPIT_GENERATION")
      const options = { directory: f.launch.workingDirectory, record, existingNames: [] as string[], notBefore,
        inspect: () => adapter.inspect(record.handle), identity: { uid: process.getuid!(), gid: process.getgid!() } }
      expect(readFreshFixtureReceipt(options).currentLiveAttempt).toBe(true)
      // Simulate a kernel-reused PID matching a previous scope's filename. Even
      // otherwise correct contents + same task/UID/current PID cannot satisfy it.
      expect(() => readFreshFixtureReceipt({ ...options, existingNames: [`receipt-${observed.pid}.json`] })).toThrow("pid_reused_old_file")
      expect(() => readFreshFixtureReceipt({ ...options, record: { ...record, handle: { ...record.handle, operationId: "other" } } })).toThrow("current_live_attempt_required")
      let observations = 0
      expect(() => readFreshFixtureReceipt({ ...options, inspect: () => ({ ...adapter.inspect(record.handle), ...(observations++ ? { status: "exited" as const } : {}) }) })).toThrow("current_live_attempt_required")
      const path = join(f.launch.workingDirectory, `receipt-${observed.pid}.json`)
      utimesSync(path, new Date(1), new Date(1))
      expect(() => readFreshFixtureReceipt(options)).toThrow("file_or_time_invalid")
    } finally { yield* Effect.promise(() => adapter.cancel(record.handle)) }
    expect(adapter.inspect(record.handle).status).toBe("exited")
  }))
}, 15_000)
