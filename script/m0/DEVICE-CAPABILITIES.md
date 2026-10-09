# Local simulator admission

The current simulator belongs to the ordinary operator account. Another process
of that same OS UID can call `simctl` without the SQLite lease. The existing iOS
report therefore remains `osExclusiveControl: false`; its one-install, receipt
loss, query, fence and cleanup observations do not prove OS exclusion.

`LocalDeviceBroker` now defaults to refusing dispatch. Its `acquire`, `begin`
and provider-facing `assertCommand` require a registered capability and explicit
operator probe scope. The scope and registration digest are pinned in the lease
and checked again before each provider command. A changed experiment, changed
registry, legacy lease without admission or autonomous Task/Run request is
rejected. Rejection occurs before a new lease/command, and the finite protocol
checks admission before journal activation. Historical leases remain readable.

`DeviceCapabilityRegistry` currently accepts **only probe-only registrations**.
There is no OS-exclusive positive path or boolean override. A probe flag means
that trusted host code is running the explicitly authorized operator experiment;
it is not a credential, an isolation boundary or an authorization that may be
given to an untrusted Worker. Production Task/Run code must use the default or
`purpose: "autonomous"` entry, both of which remain blocked. The probe runner is
not to be exposed as a model tool or used as a fallback after that rejection.

Read the existing observation without issuing a device command:

```sh
bun script/m0/device-capability-matrix.ts \
  --result .bench/m0-fixes/ios-broker-actual-v1/result.json \
  --audit .bench/m0-fixes/ios-broker-actual-v1/evidence-audit.json \
  --out /absolute/path/to/new-matrix.json
```

Exit `2` means production remains blocked. Result/audit bytes must agree, and
their actual `false` limitations are retained. This reader checks the linkage;
it does not turn these reports into an OS proof. The command never opens the
live broker database, installs an app or rewrites the previous evidence.

## Smallest deployment that could establish OS exclusion

The selected channel stays local iOS simulator install/query/uninstall. No new
remote distribution service is needed. A future reviewed deployment needs:

1. A dedicated device OS identity, separate from Worker 420, Signer 421 and the
   ordinary operator. Untrusted workloads must never execute under the device
   UID. Its CoreSimulator device set, state and IPC access need an actual
   boundary; merely changing `HOME`, a class flag or a SQLite owner is insufficient.
2. A private device set owned by that identity, plus a root-protected fixed
   command proxy. The proxy accepts typed operations for one frozen device and
   candidate, validates Task/Run/fence/deadline and full artifact bytes, and
   constructs its own fixed `simctl --set <private-set>` arguments. It must not
   accept arbitrary argv, shell commands, paths, environment or device IDs.
3. Host-owned, protected capability configuration binding the real device UID,
   device-set identity/path, UDID, runtime, proxy code digest and measured proof
   references. Any future autonomous admission implementation must validate that
   authority and its freshness; copying this probe registration is not enough.

Our earlier local probes selected a fixed UDID in the operator's default set.
The pinned upstream `agent-device@0.21.1` already supports
`--ios-simulator-device-set`, injects `--set` into simctl, checks managed leases,
and routes XCTest through a locked redirect under the owner's HOME with restore
on release. That route should be reused and actually checked under UID422;
source inspection alone does not establish a deployed protected proxy.

UID422 and its private device set now exist. Actual owner lifecycle testing
created, booted, shut down and deleted one new experiment device, and verified
empty-set/process/domain cleanup. UID501 and UID420 have actual public/tool
baselines and private-directory/explicit-set-path denial observations. See
[the iOS evidence record](../../docs/m0/ios-simulator.md) for the original
blocked reports and their precise scope. Default-set/live-UDID control, native
IPC exclusion and production proxy behavior remain unproven. Never fall back to
the operator identity, copy simulator databases between accounts, or silently
replace the frozen Goal's device binding.

The matrix reader itself creates no account or device set. The new
[typed command port](DEVICE-COMMAND-PORT.md) reuses broker/ledger/journal state,
but ships neither autonomous admission nor an actual UID422 executor.

## Finite experiments still required

- With the dedicated device identity, prove one authorized inspection and one
  selected-app install/query/cleanup path work, while all commands retain the
  exact device set/UDID and artifact identity. Verify final app absence and the
  owned simulator's stopped state. Use the existing build where its pin matches.
- Under the actual untrusted Worker identity, attempt the same direct device
  operations through default `simctl`, an explicit private `--set`, changed
  environment and reachable CoreSimulator IPC paths. Require OS rejection, not
  merely a missing lease. Use nonsecret canaries for filesystem boundaries.
  A separate ordinary operator UID must not gain this device's control simply
  by naming its UDID. Administrative root remains a trusted authority.
- Through the protected proxy, reject stale scope/generation, a second owner,
  wrong Task/Run/device/artifact and a caller-supplied command/path. Prove that
  denying admission produces zero provider commands. Unknown outcome keeps the
  same operation quarantined; it must not be made retryable by a new name.
- Bind a fresh device observation to a semantic action; verify App drift blocks
  it and a cleanup fault is visible and quarantines the resource. Check that the
  exact device processes/services can be reconciled without relying on the
  Worker/Signer-only stop proof or terminating unrelated simulators.

The already measured broker protocol faults can be reused as protocol evidence;
the new OS/proxy boundary needs its own limited integration observations. Until
those exist, A07/A08 and autonomous device dispatch remain incomplete. A11's
independent RecoveryJournal failure domain remains a separate requirement.
