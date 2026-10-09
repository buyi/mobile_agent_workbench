import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { OpenCodeCli, type CliOptions } from "../../runtime/src"
import { Delivery, WorkerDispatch } from "../src"

export const fixtureSource = `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("1.18.35"); process.exit(0) }
if (process.argv.includes("--help")) { console.log("--model --format"); process.exit(0) }
appendFileSync("spawn-count", String(process.pid) + "\\n");
writeFileSync("fixture-pid", String(process.pid));
const text = await Bun.stdin.text();
// Parent death can lose the initial stdin write. Keep a synthetic child alive
// in that window to test unknown ownership, without pretending prompt ACK.
const input = text ? JSON.parse(text) : { goal:{ taskId:"unacknowledged", objective:"fixture hold" } };
console.log(JSON.stringify({ fixture:true, taskId:input.goal.taskId }));
if (input.goal.objective.includes("hold")) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else process.exit(0);
`
export function setup() {
  const root = mkdtempSync(join(tmpdir(), "loopit-worker-dispatch-"))
  const executable = join(root, "fixture-runtime"), workingDirectory = join(root, "candidate")
  writeFileSync(executable, fixtureSource); chmodSync(executable, 0o700); mkdirSync(workingDirectory)
  const cli: CliOptions = { executable, executableDigest: `sha256:${createHash("sha256").update(fixtureSource).digest("hex")}`,
    version: "1.18.35", stateDirectory: join(root, "runtime") }
  const file = join(root, "opencode.db")
  const launch: WorkerDispatch.Launch = { workingDirectory, runtime: { name: "opencode", version: cli.version, sourceDigest: cli.executableDigest },
    model: { provider: "fixture", model: "unbilled" }, wallMinutes: 1 }
  const config = join(root, "config.json")
  writeFileSync(config, JSON.stringify({ file, cli, launch }))
  return { root, file, cli, launch, config, adapter: new OpenCodeCli(cli) }
}
export const withWorker = <A>(file: string, options: WorkerDispatch.Options,
  body: (worker: WorkerDispatch.Interface, delivery: Delivery.Interface) => Effect.Effect<A, unknown, any>) =>
  Effect.runPromise(Effect.gen(function* () { return yield* body(yield* WorkerDispatch.Service, yield* Delivery.Service) }).pipe(
    Effect.provide(WorkerDispatch.layerFromPath(file, options)), Effect.scoped) as Effect.Effect<A>)
export async function until(check: () => boolean, limit = 5000) {
  const deadline = Date.now() + limit
  while (!check()) { if (Date.now() > deadline) throw new Error("condition timed out"); await Bun.sleep(20) }
}
export const spawnCount = (directory: string) => {
  try { return readFileSync(join(directory, "spawn-count"), "utf8").trim().split("\n").filter(Boolean).length } catch { return 0 }
}
