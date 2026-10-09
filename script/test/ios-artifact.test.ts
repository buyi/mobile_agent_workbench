import { afterEach, expect, test } from "bun:test"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compareApps, inspectApp } from "../m0/ios-artifact"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const macTest = test.skipIf(process.platform !== "darwin")

const fields: Record<string, unknown> = {
  CFBundleIdentifier: "com.loopit.m0.artifact-fixture",
  CFBundleShortVersionString: "1.3.50",
  CFBundleVersion: "98",
  CFBundleExecutable: "Fixture",
  DTPlatformName: "iphonesimulator",
  MinimumOSVersion: "15.0",
}
const escapeXml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
function app(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "loopit-ios-artifact-test-"))
  roots.push(root)
  const path = join(root, "Fixture.app")
  mkdirSync(path)
  const entries = Object.entries({ ...fields, ...overrides }).filter(([, value]) => value !== undefined)
  writeFileSync(join(path, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${entries.map(([key, value]) => `<key>${key}</key>${typeof value === "number" ? `<integer>${value}</integer>` : `<string>${escapeXml(String(value))}</string>`}`).join("")}</dict></plist>`)
  writeFileSync(join(path, "Fixture"), "non-executed binary fixture bytes", { mode: 0o755 })
  writeFileSync(join(path, "main.jsbundle"), "globalThis.fixture = 1;\n")
  return path
}

macTest("identical app bytes match across install roots and file metadata changes", async () => {
  const built = app(), installed = app()
  utimesSync(join(installed, "Fixture"), new Date(0), new Date(0))
  chmodSync(join(installed, "main.jsbundle"), 0o400)
  const before = await inspectApp(built), after = await inspectApp(installed)
  expect(before.root).not.toBe(after.root)
  expect(compareApps(before, after)).toMatchObject({ matched: true, differingPaths: [], expectedInventoryValid: true, observedInventoryValid: true })
})

macTest("same bundle/version/build with replaced JS is rejected by package bytes", async () => {
  const built = app(), installed = app()
  writeFileSync(join(installed, "main.jsbundle"), "globalThis.fixture = 2;\n")
  const before = await inspectApp(built), after = await inspectApp(installed)
  expect(after.identity.bundleId).toBe(before.identity.bundleId)
  expect(after.identity.version).toBe(before.identity.version)
  expect(after.identity.build).toBe(before.identity.build)
  expect(compareApps(before, after)).toMatchObject({ matched: false, differingPaths: ["main.jsbundle"] })
})

macTest("same app metadata cannot hide an executable replacement", async () => {
  const built = app(), installed = app()
  writeFileSync(join(installed, "Fixture"), "different non-executed binary bytes")
  const before = await inspectApp(built), after = await inspectApp(installed)
  expect(after.identity.executableDigest).not.toBe(before.identity.executableDigest)
  expect(compareApps(before, after)).toMatchObject({ matched: false, differingPaths: ["Fixture"] })
})

macTest.each([
  ["CFBundleIdentifier", ""],
  ["CFBundleShortVersionString", 1350],
  ["CFBundleVersion", undefined],
  ["DTPlatformName", "  "],
  ["CFBundleExecutable", ""],
])("missing or malformed %s cannot become an app identity", async (field, value) => {
  await expect(inspectApp(app({ [String(field)]: value }))).rejects.toThrow(`Application identity field ${field}`)
})

macTest("declared executable must exist as a regular file in the package", async () => {
  await expect(inspectApp(app({ CFBundleExecutable: "Missing" }))).rejects.toThrow("Package executable is missing or invalid")
})

macTest("changed manifest entries cannot be hidden behind the previous digest", async () => {
  const expected = await inspectApp(app())
  const observed = structuredClone(expected)
  observed.entries.find((entry) => entry.path === "main.jsbundle")!.digest = `sha256:${"0".repeat(64)}`
  const comparison = compareApps(expected, observed)
  expect(comparison).toMatchObject({ matched: false, differingPaths: ["main.jsbundle"], expectedInventoryValid: true, observedInventoryValid: false })
})

macTest("matching forged digest fields do not authenticate either inventory", async () => {
  const expected = await inspectApp(app()), observed = await inspectApp(app())
  expected.digest = observed.digest = `sha256:${"0".repeat(64)}`
  expect(compareApps(expected, observed)).toMatchObject({ matched: false, differingPaths: [], expectedInventoryValid: false, observedInventoryValid: false })
})

macTest("relative in-package links participate in byte identity", async () => {
  const first = app(), second = app()
  for (const path of [first, second]) {
    copyFileSync(join(path, "main.jsbundle"), join(path, "same-bytes.jsbundle"))
    expect(readFileSync(join(path, "main.jsbundle"))).toEqual(readFileSync(join(path, "same-bytes.jsbundle")))
  }
  symlinkSync("main.jsbundle", join(first, "alias"))
  symlinkSync("same-bytes.jsbundle", join(second, "alias"))
  expect(compareApps(await inspectApp(first), await inspectApp(second))).toMatchObject({ matched: false, differingPaths: ["alias"] })
})

macTest("links escaping the package and symbolic app roots are rejected", async () => {
  const path = app()
  writeFileSync(join(path, "../outside.txt"), "fixture")
  symlinkSync("../outside.txt", join(path, "outside-link"))
  await expect(inspectApp(path)).rejects.toThrow("App link escapes package")
  const link = join(path, "../root-link.app")
  symlinkSync(path, link)
  await expect(inspectApp(link)).rejects.toThrow("App root must not be a symbolic link")
})
