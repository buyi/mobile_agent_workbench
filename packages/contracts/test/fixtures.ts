import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { checkFrozen, type ContractIssue, digestOf, parse, parseContract, validateGate } from "../src"

export const fixtureDir = join(import.meta.dir, "../fixtures")

type Op = ["set", string, unknown] | ["delete", string] | ["push", string, unknown]
export interface Case {
  id: string
  fixture: string
  check?: "parse" | "frozen" | "gate"
  patch?: Op[]
  expect: string
}

export const baseline = (name: string): any => JSON.parse(readFileSync(join(fixtureDir, "valid", `${name}.json`), "utf8"))
export const cases = (): { dataset: string; cases: Case[] } => JSON.parse(readFileSync(join(fixtureDir, "cases.json"), "utf8"))

/** Digest over every fixture file, reported by `bench` so results bind to an exact dataset. */
export function datasetDigest() {
  const files = ["cases.json", ...readdirSync(join(fixtureDir, "valid")).sort().map((f) => `valid/${f}`)]
  return digestOf(files.map((file) => [file, readFileSync(join(fixtureDir, file), "utf8")]))
}

function apply(target: any, [op, path, value]: Op) {
  const keys = path.split(".")
  const last = keys.pop()!
  const parent = keys.reduce((node, key) => node[key], target)
  if (op === "set") parent[last] = value
  else if (op === "push") parent[last].push(value)
  else if (Array.isArray(parent)) parent.splice(Number(last), 1)
  else delete parent[last]
}

export function run(item: Case): ContractIssue[] {
  const input = structuredClone(baseline(item.fixture))
  for (const op of item.patch ?? []) apply(input, op)
  const parsed = parseContract(input)
  if (!parsed.ok) return [...parsed.issues]
  if (item.check === "frozen") return checkFrozen(parsed.value.value as any)
  if (item.check === "gate") {
    const goal = parse("goal", baseline("goal"))
    if (!goal.ok) throw new Error("goal baseline must parse")
    return validateGate(parsed.value.value as any, goal.value)
  }
  return []
}
