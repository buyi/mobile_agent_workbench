import { Cause, Exit, Schema } from "effect"
import { ArtifactEnvelope, Evidence } from "./artifact"
import { Command, CommandReceipt } from "./command"
import { EventEnvelope } from "./event"
import { ContextManifest, ExecutionSpec, RuntimeCapabilities } from "./execution"
import { GateDecision } from "./gate"
import { GoalSpec, validateGoal } from "./goal"
import { type ContractIssue, issue, type ParseResult } from "./issue"
import { MilestoneManifest, validateMilestone } from "./milestone"
import { OperationRecord } from "./operation"
import { PolicyRef } from "./policy"
import { Plan, StageResult, validatePlan, validateStageResult } from "./stage"

interface Entry {
  readonly schema: Schema.Codec<any, any, never, never>
  readonly validate?: (value: any) => ContractIssue[]
}

// kind -> version -> entry. Adding a version never mutates an existing one.
export const contracts = {
  goal: { 1: { schema: GoalSpec, validate: validateGoal } },
  policy: { 1: { schema: PolicyRef } },
  context: { 1: { schema: ContextManifest } },
  execution: { 1: { schema: ExecutionSpec } },
  "runtime-capabilities": { 1: { schema: RuntimeCapabilities } },
  plan: { 1: { schema: Plan, validate: validatePlan } },
  "stage-result": { 1: { schema: StageResult, validate: validateStageResult } },
  artifact: { 1: { schema: ArtifactEnvelope } },
  evidence: { 1: { schema: Evidence } },
  gate: { 1: { schema: GateDecision } },
  event: { 1: { schema: EventEnvelope } },
  operation: { 1: { schema: OperationRecord } },
  milestone: { 1: { schema: MilestoneManifest, validate: validateMilestone } },
  command: { 1: { schema: Command } },
  receipt: { 1: { schema: CommandReceipt } },
} satisfies Record<string, Record<number, Entry>>

export type ContractKind = keyof typeof contracts
type Decoded<K extends ContractKind> = (typeof contracts)[K][1]["schema"]["Type"]

const VERSION = /^([a-z][a-z-]*)\/(\d+)$/

export function supportedVersions(): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(contracts).map(([kind, versions]) => [kind, Object.keys(versions).map((v) => `${kind}/${v}`)]),
  )
}

function decode(entry: Entry, input: unknown): ParseResult<unknown> {
  const exit = Schema.decodeUnknownExit(entry.schema)(input, { errors: "all" })
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause)
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, issues: [issue("schema_invalid", "", message)] }
  }
  const issues = entry.validate?.(exit.value) ?? []
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: exit.value }
}

/** Parses any persisted contract by its own schemaVersion; unsupported versions are refused, not coerced. */
export function parseContract(input: unknown): ParseResult<{ kind: ContractKind; version: number; value: unknown }> {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>).schemaVersion : undefined
  const match = typeof raw === "string" ? VERSION.exec(raw) : null
  if (!match) return { ok: false, issues: [issue("schema_version_missing", "schemaVersion", "Expected <kind>/<version>")] }
  const kind = match[1] as ContractKind
  const versions = contracts[kind] as Record<number, Entry> | undefined
  if (!versions) return { ok: false, issues: [issue("unknown_contract", "schemaVersion", `Unknown contract kind ${kind}`)] }
  const entry = versions[Number(match[2])]
  if (!entry)
    return {
      ok: false,
      issues: [
        issue(
          "incompatible_schema_version",
          "schemaVersion",
          `${raw} is not supported; supported: ${supportedVersions()[kind].join(", ")}`,
        ),
      ],
    }
  const result = decode(entry, input)
  return result.ok ? { ok: true, value: { kind, version: Number(match[2]), value: result.value } } : result
}

/** Parses input that must be a specific contract kind. */
export function parse<K extends ContractKind>(kind: K, input: unknown): ParseResult<Decoded<K>> {
  const result = parseContract(input)
  if (!result.ok) return result
  if (result.value.kind !== kind)
    return { ok: false, issues: [issue("wrong_contract", "schemaVersion", `Expected ${kind}, got ${result.value.kind}`)] }
  return { ok: true, value: result.value.value as Decoded<K> }
}
