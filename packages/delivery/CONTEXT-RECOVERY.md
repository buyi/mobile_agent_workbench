# Persisted context recovery

`src/integration/context-recovery.ts` reconstructs explanatory context from the
existing Delivery SQLite projections and actual artifact files. It does not need
an OpenCode native session, write to Delivery, authorize execution, clear an
unknown Runtime reservation, or evaluate the delivery Gate.

The host calls `recoverRunContext({ delivery, dispatch }, request)` with the
existing `Delivery.getTask/getRun` and `WorkerDispatch.get` services. The request
selects a Run, one candidate reference, at least one evidence reference, optional
log/native-usage references and versioned experience references. `artifactRoot`
and the artifact index must come from the operator/controller, not from model
output. Each index entry contains a root-relative path, role, SHA-256 digest,
Task/Goal revision, persisted Run/Attempt identity and observation/expiry times.
The host should freeze and atomically archive that index and returned snapshot
alongside its other Run artifacts. File metadata is not an independent verifier
signature or proof that a claimed observation is true.

Recovery requires the current frozen Goal, its stored digest, Run, Dispatch input,
ContextManifest and ExecutionSpec to agree. A stale revision, missing persisted
input, missing referenced file, wrong digest, expired observation, escaping path
or symlink, non-regular file, mismatched artifact identity or conflicting native
usage blocks recovery without a partial success snapshot. Explicit artifacts
from other persisted Runs of the same Goal are allowed, with their own Attempt
binding; no sessions or artifact directories are implicitly searched. Material
references in the persisted context's candidate/knowledge/history/appended fields
also require actual bytes and matching digests. Frozen policy/config pins are
preserved as descriptive metadata, not reloaded as executable instructions.

All selected files are hashed completely, while output excerpts default to 4 KiB
per file and 32 KiB total (maximum 64 KiB/256 KiB). Original refs, digests, byte
counts and truncation flags remain in the snapshot. Index/reference lists are
limited to 64 entries. Regular files are limited to 1 GiB, structured evidence
and experience to 8 MiB, native JSON lines to 1 MiB and unique model steps to
10,000. Oversized or malformed required material blocks, rather than silently
omitting validation. File reads check metadata and inode consistency before and
after reading; the host must still protect the artifact directory from concurrent
untrusted mutation. Excerpts have `trustedAsInstruction: false`.

Generic evidence is retrieved observation data. A file with `evidence/1` also
receives the existing evidence contract's Goal, acceptance, candidate and issuer
checks. Neither form independently proves acceptance here: every ready snapshot
has `gate: "not_evaluated"`, `resumeAuthorized: false` and `nativeSessionUsed: false`.
The caller must never use `ready` as permission to resume an unknown process.

Native JSONL usage is read from the actual hashed file, using OpenCode's
`step_finish` / `part.type: "step-finish"` events and `input`, `output`, `reasoning`,
`cache.read`, `cache.write` token keys. Identical repeated PartIDs count once;
inconsistent repetitions, including reuse in another session, block. Native
`total` is reported separately and is never added to the category sums. Native
cost is retained as an unverified reported value, including zero. Dollar cost
stays `known: false`; neither zero nor missing native cost establishes free use
or compliance with a USD cap. Provenance lists the original ref/digest and step
and duplicate counts. Upper-layer retries are derived from persisted
`Run.priorRunId`; model steps do not reveal provider-internal retries, which stay
unknown. `aggregateNativeUsage` is a pure helper for already-established source
provenance; it does not itself authenticate its supplied events or Run IDs.

`createExperienceCandidate(snapshot, { id, version, summary, expiresAt })` returns
a `candidate-experience/1` artifact for the host to archive atomically as a new
immutable file. It does not create a database or update policy. The candidate
records Goal scope, version, creation/expiry, source snapshot digest and source
artifact refs/digests. A later explicit retrieval checks scope/version/expiry and
the original source bytes again and records `applied: false`. The snapshot digest
is a traceability label, not a signature. All experience remains a candidate;
promotion to policy is outside this module.

The ordinary test uses actual SQLite reopen and persisted outbox/Dispatch input,
then deliberately fails Runtime preparation before any native child or model is
launched. It covers artifact tampering and path escape, stale Goal/reference and
experience rejection, bounded logs, upper-layer lineage, native usage dedup and
conflicts. These local protocol tests are not M0 independent-domain or real
device verification.

```sh
env XDG_CONFIG_HOME=/tmp/loopit-context-test/config \
    XDG_DATA_HOME=/tmp/loopit-context-test/data \
    XDG_CACHE_HOME=/tmp/loopit-context-test/cache \
    XDG_STATE_HOME=/tmp/loopit-context-test/state \
    bun test packages/delivery/test/context-recovery.test.ts
```
