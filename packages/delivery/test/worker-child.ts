import { readFileSync, writeFileSync } from "node:fs"
import { Effect } from "effect"
import { OpenCodeCli } from "../../runtime/src"
import { withWorker } from "./worker-fixture"

const [configPath, mode, marker] = process.argv.slice(2)
const config = JSON.parse(readFileSync(configPath, "utf8"))
const adapter = new OpenCodeCli(config.cli)
const start = adapter.startPrepared.bind(adapter)
adapter.startPrepared = (input, operationId, token) => {
  if (mode === "crash-before-start") {
    writeFileSync(marker, "reservation committed before adapter start")
    process.kill(process.pid, "SIGKILL")
  }
  const handle = start(input, operationId, token)
  if (mode === "crash-after-start") {
    writeFileSync(marker, JSON.stringify(handle))
    process.kill(process.pid, "SIGKILL")
  }
  return handle
}
if (mode === "slow-probe") {
  const prepare = adapter.prepareStart.bind(adapter)
  adapter.prepareStart = (input, operationId) => {
    writeFileSync(marker, "before asynchronous probe")
    return prepare(input, operationId)
  }
}
await withWorker(config.file, { adapter, launch: () => config.launch }, (worker) => Effect.gen(function* () {
  yield* worker.drain()
  writeFileSync(marker, "drained")
}))
