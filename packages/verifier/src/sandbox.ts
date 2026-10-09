import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { dirname } from "node:path"
import { createHash } from "node:crypto"

export type ChildResult = { code: number | null; signal: string | null; stdout: string; stderr: string;
  timedOut: boolean; overflow: boolean; error?: string }
export type CaseExecution = { runtime: string; runner: string; compiled: string; scratch: string; request: unknown; timeoutMs: number }

/** Narrow pure-function profile. Default denies network, process-fork, signals,
 * Mach IPC and all non-system reads. Only the fixed Bun can be exec'd; no shell.
 * This intentionally does not use the general build sandbox's broader grants. */
export function fixtureSandbox(input: CaseExecution) {
  const params = { RUNTIME: realpathSync(input.runtime), RUNNER: realpathSync(input.runner),
    CANDIDATE: realpathSync(input.compiled), SCRATCH: realpathSync(input.scratch), RUNNER_DIR: realpathSync(dirname(input.runner)) }
  const text = [
    "(version 1)", "(deny default)",
    '(allow process-exec (literal (param "RUNTIME")))',
    "(allow sysctl-read)", "(allow file-read-metadata)",
    // dyld opens the root directories, and ICU loads macOS timezone data.
    // Literal directory reads do not grant reads of files beneath them.
    '(allow file-read-data (literal "/") (literal "/private") (subpath "/private/var/db/timezone"))',
    '(allow file-read-data (literal (param "RUNNER_DIR")))',
    '(allow file-read-data (subpath "/System") (subpath "/usr/lib") (subpath "/private/var/db/dyld")',
    ' (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom")',
    ' (literal (param "RUNTIME")) (literal (param "RUNNER")) (literal (param "CANDIDATE")) (subpath (param "SCRATCH")))',
    '(allow file-write* (subpath (param "SCRATCH")) (literal "/dev/null"))',
  ].join("\n")
  return { text, params, digest: `sha256:${createHash("sha256").update(JSON.stringify({ text, params })).digest("hex")}` }
}

export async function executeCase(input: CaseExecution): Promise<ChildResult> {
  if (process.platform !== "darwin") throw new Error("seatbelt_required")
  const profile = fixtureSandbox(input)
  return captureProcess("/usr/bin/sandbox-exec", ["-p", profile.text,
    ...Object.entries(profile.params).flatMap(([key, value]) => ["-D", `${key}=${value}`]), input.runtime, input.runner, input.compiled],
  input.scratch, input.request, input.timeoutMs)
}

/** No inherited environment or keys; output overflow/timeout kills this child.
 * Production profile denies forks, so a timeout cannot leave a forked process. */
export function captureProcess(executable: string, args: string[], scratch: string, request: unknown, timeoutMs: number): Promise<ChildResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error("invalid_child_timeout")
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd: scratch, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: scratch, TMPDIR: scratch,
        XDG_CONFIG_HOME: scratch, XDG_CACHE_HOME: scratch, XDG_DATA_HOME: scratch, XDG_STATE_HOME: scratch,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } })
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
    let bytes = 0, overflow = false, timedOut = false, error: string | undefined, settled = false
    const stop = () => { try { child.kill("SIGKILL") } catch {} }
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    const done = (code: number | null, signal: string | null) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      resolve({ code, signal, stdout: Buffer.concat(chunks.stdout).toString("utf8"), stderr: Buffer.concat(chunks.stderr).toString("utf8"),
        timedOut, overflow, ...(error ? { error } : {}) })
    }
    for (const stream of ["stdout", "stderr"] as const) child[stream].on("data", (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 16 * 1024) { overflow = true; stop(); return }
      chunks[stream].push(Buffer.from(chunk))
    })
    child.on("error", (value) => { error = value.message; done(null, null) })
    child.on("close", done)
    child.stdin.on("error", () => { error = "stdin_unavailable"; stop() })
    child.stdin.end(JSON.stringify(request) + "\n")
  })
}
