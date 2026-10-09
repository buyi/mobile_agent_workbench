/** No SDK, socket or environment-based admission identity. The launcher keeps
 * Supervisor scope/generation private; the controller binds the observed PID. */
export function controlMatrixFixtureSource(bunPath: string, identity = { uid: 420, gid: 420 }) {
  if (!bunPath.startsWith("/") || /[\r\n]/.test(bunPath) || !Number.isSafeInteger(identity.uid) || !Number.isSafeInteger(identity.gid))
    throw new Error("invalid_fixture_identity")
  return `#!${bunPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("1.18.35"); process.exit(0) }
if (process.argv.includes("--help")) { console.log("--model --format"); process.exit(0) }
if (process.argv.includes("debug") && process.argv.includes("config")) { console.log(process.env.OPENCODE_CONFIG_CONTENT); process.exit(0) }
const input = JSON.parse(await Bun.stdin.text());
if (process.getuid() !== ${identity.uid} || process.getgid() !== ${identity.gid}) throw new Error("fixture identity failed");
writeFileSync("receipt-" + process.pid + ".json", JSON.stringify({ uid:process.getuid(), gid:process.getgid(), pid:process.pid, taskId:input.goal.taskId, fixture:true, modelCalls:0 }), {flag:"wx",mode:0o600});
console.log(JSON.stringify({fixture:true,modelCalls:0}));
process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);
`
}
