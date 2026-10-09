import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { OpenCodeCli } from "../../runtime/src"
import { holdUnacknowledgedStart } from "../../../script/m0/owner-loss-protocol"
import { withWorker, until } from "./worker-fixture"
const [path, marker] = process.argv.slice(2),
  config = JSON.parse(readFileSync(path, "utf8")),
  adapter = new OpenCodeCli(config.cli)
await withWorker(config.file, { adapter, launch: () => config.launch }, (worker, delivery) =>
  holdUnacknowledgedStart(worker, delivery, "run-1", async (record, item) => {
    await until(() => {
      const observed = adapter.inspect(record.handle)
      return (
        observed.status === "running" &&
        !!observed.pid &&
        existsSync(join(config.launch.workingDirectory, `receipt-${observed.pid}.json`))
      )
    })
    writeFileSync(marker, JSON.stringify({ record, item, observed: adapter.inspect(record.handle) }), { flag: "wx" })
  }),
)
