import { expect, test } from "bun:test"
import { runProcess } from "../src/process"

test("a hanging child is killed within a deterministic deadline", async () => {
  const started = performance.now()
  const result = await runProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 })
  expect(result.timedOut).toBe(true)
  expect(result.code).not.toBe(0)
  expect(performance.now() - started).toBeLessThan(1500)
})

test("a failed executable is distinguishable from a completed denial", async () => {
  const result = await runProcess(["/nonexistent/loopit-probe"], { timeoutMs: 100 })
  expect(result.error).toBeDefined()
  expect(result.timedOut).toBe(false)
})

test("completed output and nonzero exit are preserved", async () => {
  const result = await runProcess([process.execPath, "-e", 'console.log("ok"); console.error("denied"); process.exit(7)'])
  expect(result).toMatchObject({ code: 7, timedOut: false, signal: null, stdout: "ok\n", stderr: "denied\n" })
})
