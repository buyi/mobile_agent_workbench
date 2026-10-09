import { existsSync, realpathSync, statSync } from "node:fs"
import { userInfo } from "node:os"
import { digestOf } from "@loopit/contracts"
import { assertPolicy, type SandboxBackend, type SandboxCapabilities, type SandboxPolicy, SandboxPolicyError } from "./contract"
import { runProcess } from "./process"
import { inspectWorkerAccount } from "./worker-account"

// macOS backend: Seatbelt (`sandbox-exec`) confines writes, network and IPC; the
// dedicated low-privilege account adds a separate boundary only after the actual
// protected paths and account permissions have been verified on the host.

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec"
export const DEFAULT_WORKER_USER = "loopit-worker"

// Lookups most CLIs need (user/group info, logging, TLS trust evaluation). Deliberately
// absent: SecurityServer/securityd (keychain), dnssd (direct DNS), launchservicesd, pboard.
const MACH_SERVICES = [
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.logger",
  "com.apple.system.notification_center",
  "com.apple.trustd",
  "com.apple.trustd.agent",
]

/** Resolve every symlink on this host. Policy roots must already exist as directories. */
export function canonical(path: string) {
  try {
    const resolved = realpathSync(path)
    if (!statSync(resolved).isDirectory()) throw new Error("not a directory")
    return resolved
  } catch (error) {
    throw new SandboxPolicyError(`Sandbox directory cannot be resolved: ${path}: ${String(error)}`)
  }
}

export function profile(policy: SandboxPolicy) {
  assertPolicy(policy)
  const resolved = { ...policy, workdir: canonical(policy.workdir), writable: policy.writable.map(canonical), denyRead: policy.denyRead.map(canonical) }
  assertPolicy(resolved)
  const params: Record<string, string> = { WORKDIR: resolved.workdir }
  resolved.writable.forEach((path, i) => (params[`WRITABLE_${i}`] = path))
  resolved.denyRead.forEach((path, i) => (params[`DENY_${i}`] = path))
  const subpaths = (prefix: string) =>
    Object.keys(params)
      .filter((key) => key.startsWith(prefix))
      .map((key) => `(subpath (param "${key}"))`)
      .join(" ")

  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow pseudo-tty)",
    "(allow ipc-posix-shm* ipc-posix-sem)",
    `(allow mach-lookup ${MACH_SERVICES.map((name) => `(global-name "${name}")`).join(" ")})`,
    // Reads are broad so toolchains work; secrets are excluded below and by account permissions.
    "(allow file-read*)",
    ...(policy.denyRead.length > 0 ? [`(deny file-read* ${subpaths("DENY_")})`] : []),
    `(allow file-write* (subpath (param "WORKDIR")) ${subpaths("WRITABLE_")})`,
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))',
    ...(policy.network.mode === "proxy"
      ? [`(allow network-outbound (remote ip "localhost:${policy.network.port}"))`]
      : []),
  ]
  return { text: lines.join("\n"), params }
}

export const seatbelt = (options: { workerUser?: string } = {}): SandboxBackend => {
  const workerUser = options.workerUser ?? process.env.LOOPIT_WORKER_USER ?? DEFAULT_WORKER_USER
  return {
    name: "seatbelt",
    command(argv, policy) {
      if (argv.length === 0 || argv[0].startsWith("-")) throw new SandboxPolicyError("Command must start with an executable")
      if (!policy.env.PATH) throw new SandboxPolicyError("Sandbox env must set PATH explicitly")
      const { text, params } = profile(policy)
      return {
        argv: [SANDBOX_EXEC, "-p", text, ...Object.entries(params).flatMap(([k, v]) => ["-D", `${k}=${v}`]), ...argv],
        env: { ...policy.env },
        profileDigest: digestOf({ backend: "seatbelt/1", text, params }),
      }
    },
    async probe(): Promise<SandboxCapabilities> {
      const notes: string[] = []
      const runAsUser = userInfo().username
      let available = process.platform === "darwin" && existsSync(SANDBOX_EXEC)
      if (available) {
        const smoke = await runProcess([SANDBOX_EXEC, "-p", "(version 1)(allow default)", "/usr/bin/true"])
        available = smoke.code === 0 && !smoke.timedOut && !smoke.error
        if (!available) notes.push(`sandbox-exec smoke blocked: ${smoke.timedOut ? "timeout" : smoke.error ?? smoke.stderr.trim()}`)
      } else notes.push(`sandbox-exec unavailable on ${process.platform}`)
      const account = await inspectWorkerAccount(workerUser)
      const dedicatedUser = account.valid
      notes.push(...account.notes)
      notes.push("statuses stay unverified until `bench verify --suite sandbox-contract` passes on this host")
      return {
        backend: "seatbelt",
        platform: `${process.platform}-${process.arch}`,
        available,
        runAsUser,
        dedicatedUser,
        filesystemWrite: available ? "unverified" : "unsupported",
        filesystemRead: available ? "unverified" : "unsupported",
        network: available ? "unverified" : "unsupported",
        // No PID namespace: the sandbox is inherited by children but they stay visible to
        // and signalable by same-user processes outside it. The Supervisor must track the tree.
        processIsolation: available ? "limited" : "unsupported",
        userIsolation: dedicatedUser ? "unverified" : "unsupported",
        notes,
      }
    },
  }
}
