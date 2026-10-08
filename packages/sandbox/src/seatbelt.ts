import { existsSync } from "node:fs"
import { userInfo } from "node:os"
import { digestOf } from "@loopit/contracts"
import { assertPolicy, type SandboxBackend, type SandboxCapabilities, type SandboxPolicy, SandboxPolicyError } from "./contract"

// macOS backend: Seatbelt (`sandbox-exec`) confines writes, network and IPC; the
// dedicated low-privilege account (script/macos/setup-worker.sh) keeps the operator's
// files and keychains out of reach by Unix permissions as a second, independent layer.

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

/** macOS reports /tmp, /var and /etc through /private; Seatbelt matches resolved paths. */
export function canonical(path: string) {
  return /^\/(tmp|var|etc)(\/|$)/.test(path) ? `/private${path}` : path
}

export function profile(policy: SandboxPolicy) {
  assertPolicy(policy)
  const params: Record<string, string> = { WORKDIR: canonical(policy.workdir) }
  policy.writable.forEach((path, i) => (params[`WRITABLE_${i}`] = canonical(path)))
  policy.denyRead.forEach((path, i) => (params[`DENY_${i}`] = canonical(path)))
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
        const smoke = Bun.spawnSync([SANDBOX_EXEC, "-p", "(version 1)(allow default)", "/usr/bin/true"])
        available = smoke.exitCode === 0
        if (!available) notes.push(`sandbox-exec smoke test failed: ${smoke.stderr.toString().trim()}`)
      } else notes.push(`sandbox-exec unavailable on ${process.platform}`)
      const dedicatedUser = runAsUser === workerUser
      if (!dedicatedUser) notes.push(`running as ${runAsUser}, not the dedicated account ${workerUser}; user isolation absent`)
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
