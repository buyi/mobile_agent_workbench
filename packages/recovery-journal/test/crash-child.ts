// Test-only crash boundary: reservation COMMIT is complete, but no response is emitted.
import { readFileSync, writeFileSync } from "node:fs"
import { JournalStore } from "../src/store"

const [database, journalId, intentFile, marker] = process.argv.slice(2)
const store = new JournalStore(database, journalId)
store.reserveDispatch(JSON.parse(readFileSync(intentFile, "utf8")), "worker-1")
writeFileSync(marker, "committed-without-acknowledgement")
await new Promise(() => setInterval(() => {}, 1000))

