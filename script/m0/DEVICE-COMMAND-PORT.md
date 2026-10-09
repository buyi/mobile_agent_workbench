# Fixed device command port

`device-binding.ts` and `device-command-port.ts` add a host-only seam between the
existing `LocalDeviceBroker`, operation ledger and a future UID422 executor.
They contain no subprocess/device calls, Runner control loop, production
admission implementation, listener or new database. The default capability
registry continues to refuse autonomous dispatch.

## Inputs and trust

The protected host constructs `HostDeviceBindings` from bounded configuration
bytes and independently supplied expected SHA-256 pins. Each binding fixes the
resource/revision, owner UID422, canonical private-set path, UDID/runtime/device
type, application bundle, capability digest and executor identity/code digest.
Returned values are copies. A pin establishes configuration identity; it does
not prove that the path is still private, the device exists, or OS exclusion.
The eventual host loader must obtain those pins from operator/CI configuration
outside Worker write access and verify current filesystem/device observations.

`TypedDeviceCommandPort` receives the lease, existing ledger, artifact store,
host operation authority and optional executor through its constructor. These
are trusted adapters, **not request fields, model tools or boolean overrides**.
The new `DeviceAdmissionAuthority` interface allows that host wiring and local
fixtures; the shipped `DeviceCapabilityRegistry` still has no autonomous
positive path. A probe lease is rejected by this port rather than converted.

The only request commands are `inspect`, `boot`, `install` with an approved
artifact digest, `uninstall`, and `shutdown`. There is no caller-selected UDID,
path, argv, environment, shell, arbitrary semantic action or executor callback.
An install path must eventually be resolved by the trusted executor from the
approved digest and checked against complete actual app bytes.

Every request binds operation/idempotency IDs, Task/Run, frozen Goal revision
and digest, resource, binding digest, and the canonical request digest. The
host authority must read an **already accepted persistent operation** and the
current Task/Run/Goal permission/budget state; returning an echo of the request
would violate the interface. It additionally binds the current lease, owner,
generation, epoch, original deadline, and authorization expiry. Dispatch needs
`mode=dispatch`; `reconcile-only` cannot start a command. This repository does
not yet ship that production Task/Run adapter.

## Dispatch and unknown outcomes

The port checks binding, host authority, current resource admission and the
executor descriptor before writing intent or contacting the journal. Missing
production admission or executor therefore causes zero provider dispatch.
Canonical request bytes must be durably stored and reread with their full pin.
The existing ledger records intent; the existing broker reserves the command;
the existing journal grants its single-use fenced permit. After those awaits,
the port rechecks current authorization and the broker before invoking the
executor. No transaction contains a provider call or an `await`.

The future executor receives a copy of the fixed binding, lease/deadline,
authorization expiry, request and full journal permit. It must enforce current
fence/admission at the **actual OS dispatch boundary**, bound every subprocess,
and construct its own fixed arguments. This TypeScript check does not close an
external process race or prove that an arbitrary injected callback is safe.

An executor returns an artifact reference. The port reads complete bounded
observation bytes, checks their pin and operation/dispatch/request/device/
Task/Run/Goal/fence bindings, then records the receipt. Install success requires
the observed app digest to match the approved digest; boot/shutdown/uninstall
require the corresponding observed state. These trusted provider observations
are not an independent Signer `InstallReceipt` or milestone `GateDecision`.

Missing, inconsistent or lost receipts leave both operation and resource
unknown/quarantined. Same-ID replay and renamed requests cannot grant another
dispatch. `query` requires the original unknown operation, request and epoch,
rechecks the external journal authority, and calls only the executor's query
method. It neither reserves a second dispatch nor invokes install/execute.
Unavailable queries preserve unknown. A valid query settles the existing
operation, clears only that in-flight marker and **keeps the lease quarantined**
until separate trusted cleanup observations authorize release.

A hard process crash before `unknown` is recorded may leave a reserved command;
this API does not infer that it never started or silently release it. A trusted
stop/reconciliation procedure is still required. There is no automatic cleanup
or new owner admission after that uncertainty.

## Local validation and deployment gaps

### Reused mobile runtime

`mobile-runtime.ts` is a host library factory over the clean
`vendor/mobile-ui-runtime` submodule at
`04975ff4e63f3448e19e8c5ec1c6394dd12a1ad1`. It directly imports the public
TypeScript `core/runtime.ts`, `app-ops/runtime.ts`, `evidence/runtime.ts` and
their provider contracts. It does not load the package's default DSH plugin,
start another Agent, or copy selectors, snapshot diffs, queues, RunLedger or
exploration algorithms. The revision constant records intended provenance;
the checkout/build still has to verify the actual commit and clean source.

The UI provider factory is mandatory. AppOps and Evidence exist only when the
trusted host supplies their providers. There is no default process provider,
model tool registration or real device adapter in this factory. Its local test
loads the actual pinned runtime with an explicitly fake provider: open,
snapshot, revision-bound semantic action, wait and close; stale and ambiguous
actions; a lost receipt with no blind repeat; and the existing shared UI,
AppOps and Evidence queue. An empty fixture evidence manifest is not device
evidence. Those tests establish source/API wiring, not a UID422 deployment or
autonomous admission.

The two interfaces serve different purposes. The reused runtime owns UI
semantics and provider ordering; the command port owns the existing fixed
device binding, accepted operation, lease/fence and journal boundary for its
limited command enum. They are not yet joined into a production semantic
dispatch adapter. A future protected UID422 host must put accepted Task/Run
authorization and durable operation accounting around every real provider
call, including UI actions and observations. Core resynchronization after an
`indeterminate` action only restores an in-memory snapshot: it does not settle
an unknown Broker operation, release its quarantine or authorize a repeat.
The cooperative upstream queue is not OS exclusion. Neither host factory nor
provider constructor may be exposed directly to a Worker/model as authority.

The pinned mobile runtime's `AgentDeviceProviderConfig` currently lacks a
private-set field. The underlying `agent-device@0.21.1` already supports
`--ios-simulator-device-set` and the associated XCTest redirect/lock/restore
route. A future reviewed adapter can configure a fixed, protected executable
wrapper from the trusted host, inject exactly the bound private-set path and
fixed UID422 HOME, and validate the selected device and fixed allowed argument
shape. Caller-supplied set/HOME/route overrides must fail closed. This is only
an integration plan: no wrapper or arbitrary argv interface is added here, no
upstream files are patched, and the existing Runner lifecycle is reused.

`script/test/device-command-port.test.ts` uses real local SQLite ledger/journal
stores and pinned files with explicitly named fixture admission/executor ports.
It exercises wrong bindings, injected request fields, absent authority,
concurrent connections, duplicate/renamed operations, revocation while waiting
for a permit, lost receipt/reopen, unavailable query, changed epoch and corrupt
or mismatched observation bytes. It invokes no model, administrator or device.
Fixture successes establish protocol behavior only.

Remaining deployment work is deliberately outside this implementation:

- A protected current-binding/capability loader and authoritative Task/Run
  operation adapter; the default autonomous rejection must remain until the
  measured OS boundary qualifies the resource.
- A UID422 fixed executor and artifact resolver, with actual fence checks,
  private HOME, command deadlines, observation capture and cleanup. It must not
  expose the underlying broker's administrative methods to Worker requests.
- Reuse the pinned `agent-device@0.21.1` native `--ios-simulator-device-set`
  route. Its `simctl` injection, managed lease gate and XCTest device-set
  redirect/lock/restore mechanism must be exercised under the fixed UID422
  HOME; do not implement a second Runner lifecycle. Earlier local probes used
  a fixed UDID/default set, which is not a limitation of the upstream route.
- One reviewed live-target/default-set bypass experiment and the selected
  production install/semantic/Signer/cleanup chain on the same bound device.
  Existing UID422 lifecycle and UID501/420 private-path denials do not establish
  native IPC isolation or a production command proxy. A07/A08 remain partial.
- Independent RecoveryJournal deployment remains a separate A11 requirement.
