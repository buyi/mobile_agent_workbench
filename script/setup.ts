// Links this repo's node_modules to the pinned OpenCode checkout so that
// @loopit/* packages share the exact module instances OpenCode core uses
// (effect, drizzle-orm, @opencode-ai/*). Run after `bun install` in vendor/opencode.
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { dirname, join, relative } from "node:path"

const root = join(import.meta.dir, "..")
const packageManager: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager
const version = typeof packageManager === "string" ? /^bun@(\d+\.\d+\.\d+)$/.exec(packageManager)?.[1] : undefined
if (!version) {
  console.error("workbench packageManager must pin an exact Bun version")
  process.exit(2)
}
if (Bun.version !== version) {
  console.error(`workbench Bun version mismatch: expected ${version}, received ${Bun.version}; run setup with the pinned host Bun`)
  process.exit(2)
}
const vendor = join(root, "vendor/opencode")
const core = join(vendor, "packages/core")
const nm = join(root, "node_modules")

if (!existsSync(join(core, "node_modules"))) {
  console.error("vendor/opencode dependencies missing: run `bun install --frozen-lockfile` in vendor/opencode first")
  process.exit(2)
}

const links: Record<string, string> = {
  "@opencode-ai/core": core,
  "@opencode-ai/schema": join(vendor, "packages/schema"),
  "@loopit/contracts": join(root, "packages/contracts"),
  "@loopit/delivery": join(root, "packages/delivery"),
  "@loopit/sandbox": join(root, "packages/sandbox"),
  "@loopit/runtime": join(root, "packages/runtime"),
  "@loopit/recovery-journal": join(root, "packages/recovery-journal"),
  effect: realpathSync(join(core, "node_modules/effect")),
  "drizzle-orm": realpathSync(join(core, "node_modules/drizzle-orm")),
  "@types/bun": realpathSync(join(core, "node_modules/@types/bun")),
  "@types/node": realpathSync(join(core, "node_modules/@types/node")),
  "@tsconfig/bun": realpathSync(join(vendor, "node_modules/@tsconfig/bun")),
  typescript: realpathSync(join(vendor, "node_modules/typescript")),
  ".bin/tsc": realpathSync(join(vendor, "node_modules/typescript/bin/tsc")),
  ".bin/tsserver": realpathSync(join(vendor, "node_modules/typescript/bin/tsserver")),
}

for (const [name, target] of Object.entries(links)) {
  const path = join(nm, name)
  mkdirSync(dirname(path), { recursive: true })
  const rel = relative(dirname(path), target)
  if (existsSync(path) || lstatSync(path, { throwIfNoEntry: false })) {
    if (lstatSync(path).isSymbolicLink() && readlinkSync(path) === rel) continue
    rmSync(path, { recursive: true, force: true })
  }
  symlinkSync(rel, path)
  console.log(`${name} -> ${rel}`)
}
