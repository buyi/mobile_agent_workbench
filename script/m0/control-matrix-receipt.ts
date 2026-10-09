import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { digestOf } from "../../packages/contracts/src"
import type { WorkerDispatch } from "../../packages/delivery/src"
import type { OpenCodeCli } from "../../packages/runtime/src"

/** A PID is not an attempt identity. Require a file absent before dispatch,
 * created in this dispatch window, and the same currently owned live handle on
 * both sides of the bounded read. Never signal a PID or remove old receipts. */
export function readFreshFixtureReceipt(options: {
  directory: string; record: WorkerDispatch.DispatchRecord; existingNames: readonly string[]; notBefore: number
  inspect: () => ReturnType<OpenCodeCli["inspect"]>; identity?: { uid: number; gid: number }
}) {
  const identity = options.identity ?? { uid: 420, gid: 420 }
  const live = () => {
    const value = options.inspect()
    if (!options.record.input || value.status !== "running" || value.ownership !== "local" || value.processGroup !== "alive" ||
        !value.evidence.available || !value.pid || digestOf(value.handle) !== digestOf(options.record.handle) ||
        value.requestDigest !== digestOf({ input: options.record.input, operationId: options.record.handle.operationId }))
      throw new Error("matrix_receipt_current_live_attempt_required")
    return value
  }
  const before = live(), name = `receipt-${before.pid}.json`
  if (options.existingNames.includes(name)) throw new Error("matrix_receipt_pid_reused_old_file")
  const fd = openSync(join(options.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd), observedAt = Date.now()
    if (!st.isFile() || st.uid !== identity.uid || st.gid !== identity.gid || st.nlink !== 1 || st.size < 1 || st.size > 8192 ||
        Math.floor(st.birthtimeMs) < options.notBefore || Math.floor(st.mtimeMs) < options.notBefore || st.mtimeMs > observedAt + 1)
      throw new Error("matrix_receipt_file_or_time_invalid")
    const bytes = Buffer.alloc(st.size)
    let count = 0
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, count)
      if (!n) throw new Error("matrix_receipt_short_read")
      count += n
    }
    const after = fstatSync(fd), current = live(), receipt = JSON.parse(bytes.toString())
    if (after.ino !== st.ino || after.dev !== st.dev || after.size !== st.size || after.mtimeMs !== st.mtimeMs ||
        current.pid !== before.pid || receipt.pid !== before.pid || receipt.uid !== identity.uid || receipt.gid !== identity.gid ||
        receipt.taskId !== options.record.taskId || receipt.fixture !== true || receipt.modelCalls !== 0)
      throw new Error("matrix_receipt_binding_or_contents_changed")
    return { receipt, filename: name, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      handle: current.handle, requestDigest: current.requestDigest, notBefore: options.notBefore, observedAt,
      stat: { uid: st.uid, gid: st.gid, inode: st.ino, birthtimeMs: st.birthtimeMs, mtimeMs: st.mtimeMs, size: st.size },
      freshFilename: true, currentLiveAttempt: true }
  } finally { closeSync(fd) }
}
