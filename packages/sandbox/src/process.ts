import { spawn } from "node:child_process"

export interface ProcessResult {
  readonly code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly error?: string
}

/** Bounded probes only. This is not the Worker's process-tree supervisor. */
export function runProcess(argv: ReadonlyArray<string>, options: {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
} = {}): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 3000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)
    throw new Error("Probe timeout must be between 1 and 60000 ms")
  if (!argv[0]) throw new Error("Probe needs an executable")
  return new Promise((resolve) => {
    let stdout = "", stderr = "", timedOut = false, settled = false
    let fallback: ReturnType<typeof setTimeout> | undefined
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd, env: options.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    })
    const finish = (code: number | null, signal: string | null, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(fallback)
      child.stdout.destroy()
      child.stderr.destroy()
      resolve({ code, signal, stdout, stderr, timedOut, ...(error ? { error } : {}) })
    }
    // Keep diagnostics bounded even when a broken probe floods stdout/stderr.
    child.stdout.on("data", (data) => { stdout = (stdout + data.toString()).slice(-65536) })
    child.stderr.on("data", (data) => { stderr = (stderr + data.toString()).slice(-65536) })
    child.on("error", (error) => finish(null, null, error.message))
    child.on("close", (code, signal) => finish(code, signal))
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch { child.kill("SIGKILL") }
      // A detached descendant could retain the pipes: never wait indefinitely for close.
      fallback = setTimeout(() => finish(null, "SIGKILL"), 250)
    }, timeoutMs)
  })
}
