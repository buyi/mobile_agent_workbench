import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createBenchMobileRuntime, MOBILE_RUNTIME_REVISION } from "../m0/mobile-runtime.ts"
import { MobileUiRuntime } from "../../vendor/mobile-ui-runtime/src/core/runtime.ts"
import {
  MobileUiError,
  type DeviceCapabilities,
  type MobileUiProvider,
  type ProviderAction,
  type ProviderSnapshot,
} from "../../vendor/mobile-ui-runtime/src/core/protocol.ts"
import type { MobileAppOpsProvider } from "../../vendor/mobile-ui-runtime/src/app-ops/protocol.ts"
import type { EvidenceProvider } from "../../vendor/mobile-ui-runtime/src/evidence/protocol.ts"

// Only provider atoms are fake; all selector/revision/diff/queue behavior is the
// pinned runtime itself. No subprocess provider, device, model or authority port.
class FakeUiProvider implements MobileUiProvider {
  readonly name = "explicit-local-fixture"
  readonly platform = "ios" as const
  readonly target = "mobile" as const
  selected = false
  ambiguous = false
  loseReceipt = false
  actions: ProviderAction[] = []
  closed = 0
  beforeAct?: () => Promise<void>
  async open(): Promise<DeviceCapabilities> {
    return { provider: this.name, platforms: ["ios"], actions: ["press"], screenshots: false,
      revision_guard: true, structured_selectors: true, snapshot_diff: true }
  }
  async snapshot(): Promise<ProviderSnapshot> {
    const button = { provider_ref: "private-provider-target", depth: 0, role: "button", name: "Continue",
      test_id: "continue", states: { enabled: true, selected: this.selected }, actions: ["press" as const] }
    return { app: "test.fixture", truncated: false,
      nodes: this.ambiguous ? [button, { ...button, provider_ref: "other-target", test_id: "other" }] : [button] }
  }
  async act(action: ProviderAction) {
    this.actions.push(action)
    await this.beforeAct?.()
    this.selected = true
    if (this.loseReceipt) throw new MobileUiError("PROVIDER_FAILURE", "fixture action receipt lost")
  }
  async close() { this.closed++ }
}

function fixture(provider = new FakeUiProvider()) {
  const runtime = createBenchMobileRuntime({ uiProviderFactory: () => provider })
  const signal = AbortSignal.timeout(5_000)
  const request = { app: "test.fixture", platform: "ios" as const, udid: `fixture-${randomUUID()}` }
  return { provider, runtime, signal, request }
}

describe("pinned mobile-runtime host wiring (fake provider only)", () => {
  test("loads the clean pinned core directly and requires explicit providers", () => {
    const cwd = fileURLToPath(new URL("../../vendor/mobile-ui-runtime", import.meta.url))
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5_000, maxBuffer: 65_536 })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      return result.stdout.trim()
    }
    expect(git(["rev-parse", "HEAD"])).toBe(MOBILE_RUNTIME_REVISION)
    expect(git(["status", "--porcelain", "--untracked-files=no"])).toBe("")
    const { runtime } = fixture()
    expect(runtime.ui).toBeInstanceOf(MobileUiRuntime)
    expect(runtime.appOps).toBeUndefined()
    expect(runtime.evidence).toBeUndefined()
    expect(() => createBenchMobileRuntime({ uiProviderFactory: undefined as never })).toThrow("explicit_ui_provider_required")
  })

  test("open → snapshot → revision-bound semantic act → wait → close uses real core", async () => {
    const { provider, runtime, signal, request } = fixture()
    try {
      const opened = await runtime.ui.open(request, signal)
      const { snapshot } = await runtime.ui.snapshot({ session_id: opened.session_id }, signal)
      expect(snapshot.revision).toBeGreaterThan(0)
      expect(JSON.stringify(snapshot)).not.toContain("private-provider-target")
      const acted = await runtime.ui.act({ session_id: opened.session_id, base_revision: snapshot.revision,
        action: "press", target: { test_id: "continue" } }, signal)
      expect(acted.status).toBe("ok")
      if (acted.status !== "ok") throw new Error(acted.message)
      expect(acted.to_revision).toBeGreaterThan(snapshot.revision)
      expect(acted.diff.changed.some((change) => change.fields.includes("states"))).toBe(true)
      expect(provider.actions.length).toBe(1)
      expect(provider.actions[0].target?.provider_ref).toBe("private-provider-target")
      const waited = await runtime.ui.wait({ session_id: opened.session_id, base_revision: acted.to_revision,
        selector: { test_id: "continue" }, condition: "selected", timeout_ms: 100 }, signal)
      expect(waited.status).toBe("ok")
      expect((await runtime.ui.close(opened.session_id, signal)).status).toBe("ok")
      expect(provider.closed).toBe(1)
      expect((await runtime.ui.close(opened.session_id, signal)).status).toBe("already_closed")
    } finally { await runtime.ui.dispose() }
  })

  test("stale revision and ambiguous selectors never reach provider.act", async () => {
    const { provider, runtime, signal, request } = fixture()
    provider.ambiguous = true
    try {
      const { session_id } = await runtime.ui.open(request, signal)
      const first = await runtime.ui.snapshot({ session_id }, signal)
      const latest = await runtime.ui.snapshot({ session_id }, signal)
      const stale = await runtime.ui.act({ session_id, base_revision: first.snapshot.revision,
        action: "press", target: { test_id: "continue" } }, signal)
      expect(stale.status).toBe("stale_snapshot")
      const ambiguous = await runtime.ui.act({ session_id, base_revision: latest.snapshot.revision,
        action: "press", target: { role: "button", name: "Continue" } }, signal)
      expect(ambiguous.status).toBe("ambiguous")
      expect(provider.actions).toHaveLength(0)
    } finally { await runtime.ui.dispose() }
  })

  test("a lost action receipt is indeterminate and cannot be blindly repeated", async () => {
    const { provider, runtime, signal, request } = fixture()
    provider.loseReceipt = true
    try {
      const { session_id } = await runtime.ui.open(request, signal)
      const { snapshot } = await runtime.ui.snapshot({ session_id }, signal)
      const action = { session_id, base_revision: snapshot.revision, action: "press" as const,
        target: { test_id: "continue" } }
      expect((await runtime.ui.act(action, signal)).status).toBe("indeterminate")
      const repeated = await runtime.ui.act(action, signal)
      expect(repeated.status).toBe("invalid_action")
      expect("requires_resync" in repeated && repeated.requires_resync).toBe(true)
      expect(provider.actions).toHaveLength(1)
      const observed = await runtime.ui.snapshot({ session_id }, signal)
      expect(observed.snapshot.nodes[0].states.selected).toBe(true)
      // Observation resynchronizes this in-memory UI only, never a Broker/ledger unknown.
      expect(provider.actions).toHaveLength(1)
    } finally { await runtime.ui.dispose() }
  })

  test("optional AppOps and Evidence share the native UI device queue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bench-mobile-fixture-"))
    const provider = new FakeUiProvider()
    const events: string[] = []
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    provider.beforeAct = async () => { events.push("ui:start"); entered(); await held; events.push("ui:end") }
    const unexpected = async (): Promise<never> => { throw new Error("unused fixture provider operation") }
    const appOps: MobileAppOpsProvider = {
      inspect: async (request) => { events.push("app:inspect"); return { status: "blocked", app: request.app,
        artifact_path: request.artifact_path, platform: request.platform, reason_code: "fixture_no_device" } },
      install: unexpected, reload: unexpected, lifecycle: unexpected, setNetwork: unexpected,
    }
    const evidence: EvidenceProvider = {
      start: async () => { events.push("evidence:start") },
      collect: async () => { events.push("evidence:collect"); return [] },
    }
    const runtime = createBenchMobileRuntime({ uiProviderFactory: () => provider, appOpsProvider: appOps,
      evidence: { provider: evidence, artifactRoot: directory } })
    const signal = AbortSignal.timeout(5_000)
    try {
      const { session_id } = await runtime.ui.open({ app: "test.fixture", platform: "ios", udid: `fixture-${randomUUID()}` }, signal)
      const { snapshot } = await runtime.ui.snapshot({ session_id }, signal)
      const action = runtime.ui.act({ session_id, base_revision: snapshot.revision,
        action: "press", target: { test_id: "continue" } }, signal)
      await started
      const inspect = runtime.appOps!.inspect({ app: "test.fixture", artifact_path: "/fixture-not-read.app",
        platform: "ios", ui_session_id: session_id }, signal)
      const startEvidence = runtime.evidence!.start({ session_id, label: "fake-provider-only" }, signal)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(events).toEqual(["ui:start"])
      release()
      expect((await action).status).toBe("ok")
      expect((await inspect).status).toBe("blocked")
      const evidenceRun = await startEvidence
      expect(events).toEqual(["ui:start", "ui:end", "app:inspect", "evidence:start"])
      const collected = await runtime.evidence!.collect({ session_id, evidence_id: evidenceRun.evidence_id }, signal)
      expect(collected.artifacts).toEqual([])
      const manifest = JSON.parse(await readFile(collected.manifest_path, "utf8"))
      expect(manifest.session_id).toBe(session_id)
      expect(manifest.label).toBe("fake-provider-only")
      expect(manifest.artifacts).toEqual([])
    } finally { release(); await runtime.ui.dispose(); await rm(directory, { recursive: true, force: true }) }
  })
})
