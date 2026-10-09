import { isAbsolute } from "node:path"
import { MobileUiRuntime } from "../../vendor/mobile-ui-runtime/src/core/runtime.ts"
import type { MobileUiProviderFactory } from "../../vendor/mobile-ui-runtime/src/core/protocol.ts"
import { MobileAppOpsRuntime } from "../../vendor/mobile-ui-runtime/src/app-ops/runtime.ts"
import type { MobileAppOpsProvider } from "../../vendor/mobile-ui-runtime/src/app-ops/protocol.ts"
import { MobileEvidenceRuntime } from "../../vendor/mobile-ui-runtime/src/evidence/runtime.ts"
import type { EvidenceProvider } from "../../vendor/mobile-ui-runtime/src/evidence/protocol.ts"

/** Provenance pin; the checkout/build must independently verify it. */
export const MOBILE_RUNTIME_REVISION = "04975ff4e63f3448e19e8c5ec1c6394dd12a1ad1"

export type { MobileUiProvider, MobileUiProviderFactory } from "../../vendor/mobile-ui-runtime/src/core/protocol.ts"
export type { MobileAppOpsProvider } from "../../vendor/mobile-ui-runtime/src/app-ops/protocol.ts"
export type { EvidenceProvider } from "../../vendor/mobile-ui-runtime/src/evidence/protocol.ts"

export interface BenchMobileRuntimeOptions {
  /** Trusted host adapter. No default process provider or model-facing factory. */
  uiProviderFactory: MobileUiProviderFactory
  appOpsProvider?: MobileAppOpsProvider
  evidence?: { provider: EvidenceProvider; artifactRoot: string }
}

/**
 * Reuses the pinned core's selectors, revisions, diffs and shared device queue.
 * This library grants no device authority. A real provider still needs the
 * protected UID422 host and outer Task/Run, lease, fence and ledger checks.
 */
export function createBenchMobileRuntime(options: BenchMobileRuntimeOptions) {
  if (typeof options.uiProviderFactory !== "function") throw new Error("explicit_ui_provider_required")
  if (options.evidence && !isAbsolute(options.evidence.artifactRoot)) {
    throw new Error("evidence_artifact_root_must_be_absolute")
  }
  return {
    ui: new MobileUiRuntime(options.uiProviderFactory, {
      max_nodes: 500,
      history_limit: 8,
      default_poll_ms: 50,
      max_wait_ms: 5_000,
      dispose_timeout_ms: 1_000,
      preflight_actions: true,
    }),
    appOps: options.appOpsProvider ? new MobileAppOpsRuntime(options.appOpsProvider) : undefined,
    evidence: options.evidence
      ? new MobileEvidenceRuntime(options.evidence.provider, options.evidence.artifactRoot)
      : undefined,
  }
}
