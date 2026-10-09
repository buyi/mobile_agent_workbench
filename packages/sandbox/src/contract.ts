import type { CapabilityStatus } from "@loopit/contracts"

// main spec §5.5 / M0-F07. A backend turns one command into an OS-confined command.
// It does not own process lifetime: spawning, process-tree stop and cleanup belong to
// the Worker Supervisor, which runs every Shell and Runtime built-in tool through here.

export interface SandboxPolicy {
  /** Attempt working copy; always writable. Absolute, symlinks resolved. */
  readonly workdir: string
  /** Extra writable directories (e.g. a per-attempt cache). Absolute, resolved. */
  readonly writable: ReadonlyArray<string>
  /** Never readable even though general reads are allowed (operator home, keychains, other attempts). */
  readonly denyRead: ReadonlyArray<string>
  /** `none` blocks network sockets; `proxy` allows only the egress proxy on localhost. */
  readonly network: { readonly mode: "none" } | { readonly mode: "proxy"; readonly port: number }
  /** The complete environment of the command; nothing is inherited from the Worker. */
  readonly env: Readonly<Record<string, string>>
}

export interface SandboxCommand {
  readonly argv: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  /** Digest of the effective profile, recorded in the ContextManifest of the attempt. */
  readonly profileDigest: string
}

export interface SandboxCapabilities {
  readonly backend: "seatbelt" | "bwrap"
  readonly platform: string
  readonly available: boolean
  readonly runAsUser: string
  /** Whether current UID and verified service-account attributes match the configured Worker. Not proof of file isolation. */
  readonly dedicatedUser: boolean
  readonly filesystemWrite: CapabilityStatus
  readonly filesystemRead: CapabilityStatus
  readonly network: CapabilityStatus
  readonly processIsolation: CapabilityStatus
  readonly userIsolation: CapabilityStatus
  readonly notes: ReadonlyArray<string>
}

export interface SandboxBackend {
  readonly name: SandboxCapabilities["backend"]
  /** Availability facts only; statuses stay `unverified` until the conformance suite passes on this host. */
  readonly probe: () => Promise<SandboxCapabilities>
  readonly command: (argv: ReadonlyArray<string>, policy: SandboxPolicy) => SandboxCommand
}

export class SandboxPolicyError extends Error {}

export function assertPolicy(policy: SandboxPolicy) {
  const paths = [policy.workdir, ...policy.writable, ...policy.denyRead]
  for (const path of paths)
    if (!path.startsWith("/") || path.includes("\0") || /(^|\/)\.{1,2}(\/|$)/.test(path) || path.includes("//") || (path.length > 1 && path.endsWith("/")))
      throw new SandboxPolicyError(`Sandbox paths must be absolute and normalized: ${path}`)
  for (const path of [policy.workdir, ...policy.writable])
    if (policy.denyRead.some((denied) => path === denied || denied === "/" || path.startsWith(`${denied}/`) || path === "/" || denied.startsWith(`${path}/`)))
      throw new SandboxPolicyError(`Writable path ${path} lies inside a denied path`)
  if (policy.network.mode === "proxy" && !(Number.isInteger(policy.network.port) && policy.network.port > 0 && policy.network.port < 65536))
    throw new SandboxPolicyError(`Invalid proxy port ${policy.network.port}`)
}
