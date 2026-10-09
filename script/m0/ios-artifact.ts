import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { digestOf } from "../../packages/contracts/src/digest"
import { runProcess } from "../../packages/sandbox/src/process"

export interface AppEntry {
  path: string
  kind: "file" | "symlink"
  size?: number
  digest?: string
  target?: string
}
export const byteDigest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`

/** Hash package bytes and relative links; installation ownership/times are not identity. */
export async function inspectApp(input: string) {
  if (lstatSync(input).isSymbolicLink()) throw new Error("App root must not be a symbolic link")
  const root = realpathSync(input)
  const entries: AppEntry[] = []
  function walk(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const stat = lstatSync(path)
      const item = relative(root, path).split(sep).join("/")
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path)
        const resolved = realpathSync(path)
        if (!resolved.startsWith(root + sep)) throw new Error(`App link escapes package: ${item}`)
        entries.push({ path: item, kind: "symlink", target })
      } else if (stat.isDirectory()) walk(path)
      else if (stat.isFile()) entries.push({ path: item, kind: "file", size: stat.size, digest: byteDigest(readFileSync(path)) })
      else throw new Error(`Unsupported package entry: ${item}`)
    }
  }
  walk(root)
  const info = await runProcess(["/usr/bin/plutil", "-convert", "json", "-o", "-", join(root, "Info.plist")])
  if (info.code !== 0 || info.timedOut || info.error) throw new Error("Cannot parse application Info.plist")
  const plist = JSON.parse(info.stdout)
  // A byte inventory without these fields is not an installable app identity.
  // Do not let absent fields compare equal as undefined in two inventories.
  for (const key of ["CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion", "DTPlatformName", "CFBundleExecutable"]) {
    if (typeof plist[key] !== "string" || !plist[key].trim() || plist[key] !== plist[key].trim())
      throw new Error(`Application identity field ${key} must be a non-empty string`)
  }
  const executable: string = plist.CFBundleExecutable
  if (typeof executable !== "string" || executable.includes("/") || !entries.some((e) => e.path === executable && e.kind === "file"))
    throw new Error("Package executable is missing or invalid")
  const jsBundles = entries.filter((e) => e.kind === "file" && e.path.endsWith(".jsbundle"))
  return {
    schemaVersion: "ios-app-inventory/1", root, digest: digestOf(entries), entries,
    identity: { bundleId: plist.CFBundleIdentifier, version: plist.CFBundleShortVersionString, build: plist.CFBundleVersion,
      executable, executableDigest: entries.find((e) => e.path === executable)!.digest,
      platform: plist.DTPlatformName, minimumOS: plist.MinimumOSVersion, jsBundles },
  }
}

export function compareApps(expected: Awaited<ReturnType<typeof inspectApp>>, observed: Awaited<ReturnType<typeof inspectApp>>) {
  const before = new Map(expected.entries.map((e) => [e.path, e]))
  const after = new Map(observed.entries.map((e) => [e.path, e]))
  const differingPaths = [...new Set([...before.keys(), ...after.keys()])].sort()
    .filter((path) => digestOf(before.get(path) ?? null) !== digestOf(after.get(path) ?? null))
  // Inventories can be persisted and loaded later. Reconcile their contents with
  // their declared digests rather than trusting a stale or modified digest field.
  const expectedInventoryValid = expected.digest === digestOf(expected.entries)
  const observedInventoryValid = observed.digest === digestOf(observed.entries)
  return {
    matched: expectedInventoryValid && observedInventoryValid && differingPaths.length === 0 &&
      expected.digest === observed.digest && digestOf(expected.identity) === digestOf(observed.identity),
    differingPaths, expectedInventoryValid, observedInventoryValid,
  }
}

if (import.meta.main) {
  const artifact = process.argv[2]
  if (!artifact) throw new Error("Usage: bun script/m0/ios-artifact.ts <app-path>")
  console.log(JSON.stringify(await inspectApp(resolve(artifact)), null, 2))
}
