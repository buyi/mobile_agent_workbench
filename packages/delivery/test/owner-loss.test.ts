import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { Writable } from "node:stream"
import { Effect } from "effect"
import { OpenCodeCli } from "../../runtime/src"
import { coldOwnerLossReplay } from "../../../script/m0/owner-loss-protocol"
import { controlMatrixFixtureSource } from "../../../script/m0/control-matrix-fixture"
import { setup, until, withWorker } from "./worker-fixture"
import { cmd, exec, goal, withService } from "./helpers"

test("real controller SIGKILL before outbox ACK leaves live child; cold replay invokes no preparation or start", async () => {
  const f = setup(),
    source =
      controlMatrixFixtureSource(process.execPath, { uid: process.getuid!(), gid: process.getgid!() }) +
      "\nsetTimeout(() => process.exit(0), 4000);\n"
  writeFileSync(f.cli.executable, source)
  const cli = { ...f.cli, executableDigest: `sha256:${createHash("sha256").update(source).digest("hex")}` }
  f.launch.runtime.sourceDigest = cli.executableDigest
  writeFileSync(f.config, JSON.stringify({ cli, launch: f.launch, file: f.file }))
  await withService(f.file, (d) =>
    Effect.gen(function* () {
      yield* exec(d, cmd.create({ goal: goal({ objective: "fixture hold" }) }))
      yield* exec(d, cmd.start(1, "run-1"))
    }),
  )
  const marker = join(f.root, "unacknowledged.json"),
    child = spawn(process.execPath, [join(import.meta.dir, "owner-loss-child.ts"), f.config, marker], {
      env: process.env,
      stdio: "ignore",
    })
  const exited = new Promise<string | null>((resolve, reject) => {
    child.on("exit", (_code, signal) => resolve(signal))
    child.on("error", reject)
  })
  let ready: any
  try {
    await until(() => existsSync(marker))
    ready = JSON.parse(readFileSync(marker, "utf8"))
    const reservation = join(
      cli.stateDirectory,
      "reservations",
      readdirSync(join(cli.stateDirectory, "reservations"))[0],
    )
    const original = readFileSync(reservation)
    expect(child.kill("SIGKILL")).toBe(true)
    expect(await exited).toBe("SIGKILL")
    expect(() => process.kill(ready.observed.pid, 0)).not.toThrow() // ordinary same-UID observation only
    const cold = new OpenCodeCli(cli)
    let preparations = 0,
      starts = 0
    cold.prepareStart = async () => {
      preparations++
      throw new Error("unexpected preparation")
    }
    cold.startPrepared = () => {
      starts++
      throw new Error("unexpected spawn")
    }
    const result = await withWorker(f.file, { adapter: cold, launch: () => f.launch }, (w, d) =>
      coldOwnerLossReplay(w, d, ready),
    )
    expect(result.status).toBe("blocked")
    expect(result.observation.ownership).toBe("unknown")
    expect(result.observation.status).toBe("running")
    expect(result.redeliveries).toHaveLength(1)
    expect(result.redeliveries[0].attempt).toBe(ready.item.attempt + 1)
    expect(preparations).toBe(0)
    expect(starts).toBe(0)
    expect(readFileSync(reservation).equals(original)).toBe(true)
    expect(() => process.kill(ready.observed.pid, 0)).not.toThrow()
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await exited
    // The ordinary fixture has a fixed self-expiry. No recovered PID is signalled.
    if (ready?.observed.pid)
      await until(() => {
        try {
          process.kill(ready.observed.pid, 0)
          return false
        } catch {
          return true
        }
      }, 7000)
  }
}, 15_000)

test("private inherited liveness pipe EOF exits the child controller without a stored PID signal", async () => {
  const module = join(import.meta.dir, "../../../script/m0/owner-loss-protocol.ts")
  const child = spawn(
    process.execPath,
    [
      "--eval",
      `import {maintainChildLiveness} from ${JSON.stringify(module)};maintainChildLiveness(4);console.log('ready');`,
    ],
    {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe", "ignore", "pipe"],
    },
  )
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("exit", (code) => resolve(code))
    child.on("error", reject)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve())
      child.once("error", reject)
    })
    ;(child.stdio[4] as Writable).end()
    expect(await exited).toBe(94)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await exited
  }
}, 5000)
