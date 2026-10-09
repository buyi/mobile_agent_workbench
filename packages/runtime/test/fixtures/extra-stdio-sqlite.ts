import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, root, roundsText = "80"] = process.argv.slice(2);
if (!new Set(["no-extra", "extra-end", "extra-destroy", "extra-retained"]).has(mode)) throw new Error("invalid mode");
const rounds = Number(roundsText);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 80 || !root.startsWith("/private/tmp/")) throw new Error("bounded private fixture required");
mkdirSync(root, { recursive: true, mode: 0o700 });
const log = (value: unknown) => appendFileSync(join(root, "events.jsonl"), JSON.stringify(value) + "\n");
const baseEnv = { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
const databases: Database[] = [];
const openWal = (iteration: number) => {
  const db = new Database(join(root, `db-${iteration}.sqlite`));
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=FULL");
  db.run("CREATE TABLE sample(value INTEGER)");
  db.run("INSERT INTO sample VALUES (1)");
  databases.push(db);
  if (databases.length > 16) databases.shift()!.close();
};

async function cycle(iteration: number) {
  const extra = mode !== "no-extra", selfExit = mode === "no-extra" || mode === "extra-retained";
  const marker = join(root, `child-${iteration}.json`);
  const childSource = `import {createReadStream,writeFileSync} from 'node:fs';
    const marker=${JSON.stringify(marker)};
    const note=(state)=>writeFileSync(marker,JSON.stringify({pid:process.pid,state}),{mode:0o600});
    note('running');process.on('exit',()=>note('exited'));
    // Explicit independent hard lifetime, including if the parent is killed.
    setTimeout(()=>process.exit(90),15000);
    ${extra ? `const input=createReadStream('',{fd:4,autoClose:false});input.on('data',()=>{});input.on('end',()=>process.exit(0));input.on('error',()=>process.exit(91));` : ''}
    console.log('ready');${selfExit ? 'setTimeout(()=>process.exit(0),20);' : ''}`;
  let child: ChildProcess | undefined = spawn(process.execPath, ["--eval", childSource], {
    env: baseEnv, cwd: root, stdio: extra ? ["ignore", "pipe", "pipe", "ignore", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  let channel = extra ? child.stdio[4] as Writable : undefined;
  child.stdout!.resume(); child.stderr!.resume();
  const done = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child!.once("close", (code, signal) => resolve({ code, signal }));child!.once("error", reject);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => { child!.stdout!.once("data", () => resolve());child!.once("error",reject); }),
      new Promise<never>((_, reject) => { timer=setTimeout(()=>reject(new Error("ready timeout")),3000); }),
    ]);
    clearTimeout(timer);
    if (mode === "extra-end") channel!.end();
    if (mode === "extra-destroy") channel!.destroy();
    const result = await Promise.race([done,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("close timeout")),16000);})]);
    clearTimeout(timer);
    log({ iteration, childPid: child.pid, ...result, channelDestroyed: channel?.destroyed });
    if (result.code !== 0 || result.signal !== null) throw new Error("child failed");
    // The WAL descriptors stay open when the native subprocess/extra stream
    // wrappers are collected, allowing genuine descriptor reuse, not fake FDs.
    openWal(iteration);
    if (mode === "extra-retained" && channel && !channel.destroyed) channel.destroy();
    channel=undefined; child=undefined;
    Bun.gc(true);
    await Bun.sleep(1);
    Bun.gc(true);
    for (const db of databases) if ((db.query("SELECT value FROM sample").get() as any)?.value !== 1) throw new Error("WAL verification failed");
  } finally {
    clearTimeout(timer);
    // Only this unreaped ChildProcess handle is signalled; never a recorded PID.
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (child) await done.catch(()=>{});
    if (channel && !channel.destroyed) channel.destroy();
  }
}
log({ phase: "start", mode, pid: process.pid, bun: Bun.version, rounds });
try {
  for (let iteration=0; iteration<rounds; iteration++) await cycle(iteration);
  console.log(JSON.stringify({ status: "completed-without-observed-crash", mode, rounds, parentPid: process.pid }));
} finally {
  for (const db of databases) db.close();
  log({ phase: "completed", mode });
}
