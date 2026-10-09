import { realpathSync, statSync } from "node:fs"
import { userInfo } from "node:os"
import { runProcess } from "./process"

/** dscl prefixes nonstandard attributes such as IsHidden with dsAttrTypeNative. */
export function parseDirectoryAttributes(output: string): Record<string, string> {
  return Object.fromEntries(output.trim().split("\n").map((raw) => {
    const line = raw.replace(/^dsAttrType(?:Native|Standard):/, "")
    const split = line.indexOf(":")
    return [line.slice(0, split), line.slice(split + 1).trim()]
  }))
}

/** Account configuration facts, never a claim that the operator's files are protected. */
export async function inspectWorkerAccount(name: string): Promise<{ valid: boolean; notes: string[]; home?: string }> {
  const notes: string[] = []
  if (process.platform !== "darwin") return { valid: false, notes: ["dedicated-account inspection requires macOS"] }
  if (!/^[a-z_][a-z0-9_-]*$/.test(name)) return { valid: false, notes: ["invalid Worker account name"] }
  const current = userInfo()
  const record = await runProcess(["/usr/bin/dscl", ".", "-read", `/Users/${name}`, "UniqueID", "PrimaryGroupID", "NFSHomeDirectory", "UserShell", "IsHidden", "Password"])
  if (record.code !== 0 || record.timedOut || record.error)
    return { valid: false, notes: [`Worker account ${name} unavailable or its attributes could not be inspected`] }
  const attrs = parseDirectoryAttributes(record.stdout)
  const uid = Number(attrs.UniqueID), gid = Number(attrs.PrimaryGroupID)
  if (!Number.isInteger(uid) || uid < 420 || uid >= 500) notes.push("Worker UID is not a dedicated service UID in 420–499")
  if (!Number.isInteger(gid) || gid <= 0) notes.push("Worker primary group is invalid or privileged")
  if (current.uid !== uid || current.username !== name) notes.push(`running as ${current.username} (uid ${current.uid}), not verified Worker uid ${uid}`)
  if (attrs.UserShell !== "/usr/bin/false") notes.push("Worker login shell is not /usr/bin/false")
  if (attrs.IsHidden !== "1") notes.push("Worker account is not hidden")
  if (attrs.Password !== "*") notes.push("Worker password field is not disabled")
  const authority = await runProcess(["/usr/bin/dscl", ".", "-read", `/Users/${name}`, "AuthenticationAuthority"])
  if (/AuthenticationAuthority:/.test(authority.stdout)) notes.push("Worker has an authentication authority requiring manual review")
  else if (authority.timedOut || authority.error || !/No such key: AuthenticationAuthority|eDSAttributeNotFound/.test(authority.stdout + authority.stderr))
    notes.push("Worker authentication authority absence could not be verified")
  const groups = await runProcess(["/usr/bin/id", "-Gn", name])
  if (groups.code !== 0 || groups.timedOut || groups.error) notes.push("Worker group memberships could not be inspected")
  else if (groups.stdout.trim().split(/\s+/).some((group) => ["admin", "wheel"].includes(group))) notes.push("Worker belongs to an administrator group")
  let home: string | undefined
  try {
    home = realpathSync(attrs.NFSHomeDirectory ?? "")
    const stat = statSync(home)
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700) notes.push("Worker home must be an existing directory owned by Worker with mode 0700")
    if (home !== attrs.NFSHomeDirectory || home === "/" || home === "/Users") notes.push("Worker home must be a canonical private directory")
    const acl = await runProcess(["/bin/ls", "-lde", home])
    if (acl.code !== 0 || acl.timedOut || acl.error || acl.stdout.trim().split("\n").length !== 1)
      notes.push("Worker home ACLs could not be verified absent")
  } catch { notes.push("Worker home could not be resolved and inspected") }
  const valid = notes.length === 0
  notes.push("Account attributes do not prove operator/signer isolation; actual cross-account read probes remain required")
  return { valid, notes, home }
}
