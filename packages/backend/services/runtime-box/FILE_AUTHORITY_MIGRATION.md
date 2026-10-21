# File authority migration checkpoint

## Implemented

The read-only authority audit now follows deployment-binding precedence, including explicit disabled bindings and development-only legacy fallback. It checks the effective Worker's project scope rather than the legacy settings Worker's scope. Incomplete enabled bindings are critical findings.

`workbench-file-authority-activation.integration.test.ts` connects actual activation SQL values to the real effective-binding and file-authority resolvers. Signed-grant activation with `fileAuthorityReady=false` still produces a scope failure in the current file resolver; the audit now reports that failure instead of treating it as healthy. This is a characterization test, not evidence that file access is repaired.

## Remaining

Do not remove scope validation or return host storage on Worker failure. Before changing routing, introduce an explicit storage authority contract and reconcile existing authoritative bytes. Execution binding, file storage identity and Agent workspace grants must be separate concerns. The audit's precedence logic remains transitional duplication; a shared storage resolver must replace both interpretations in the next implementation slice.

No database migration, production changes, cross-Agent grants or storage relocation are implemented by this checkpoint. Worker liveness and deployment mismatch are still checked by the file resolver; the audit is not a complete replacement for live readiness checks.

## Validation

Targeted activation, effective binding, file authority, audit and integration suites: 5 files / 28 tests passed. Backend TypeScript no-emit check passed. No live file round-trip was executed.

## Explicit storage binding slice

Migration `195_project_file_storage_bindings.sql` adds an opt-in, deployment-scoped storage record. It does not backfill, relocate files or enable grants. `project-file-storage-binding.ts` resolves a ready explicit host/Worker target before legacy execution placement. Pending, blocked, malformed or database-failed records never trigger fallback. Only an absent record or the specific missing additive table retains existing routing.

The existing file-authority seam now uses this resolver; its Worker scope, deployment and liveness guards remain. Audit reads the same explicit records and validation helper. This does not yet unify all host-byte consumers or Agent mounts. Explicit host readiness must be established by a future authorized reconciliation workflow; no public mutation API or automatic activation writer is provided in this slice. Do not manually mark ready based only on Worker heartbeat.

Targeted validation: 6 files / 36 tests passed; backend TypeScript no-emit passed. Migration SQL was written, not applied or PostgreSQL integration-tested. Existing scope-mismatch projects remain unchanged until authoritative storage is verified and an explicit record is provisioned. Cross-Agent grants, Worker mount generation and UI FileRef integration remain outstanding.

## Read-only reconciliation planner

`project-file-storage-preflight.ts` compares metadata snapshots for the same Project/deployment and exact target Worker. It reports host-only, Worker-only, type and content differences without choosing which copy wins. Incomplete, stale, malformed, duplicate or unhashed evidence is rejected. Equal or empty manifests never produce storage-ready status. The evidence hash is diagnostic, not an authorization token.

This slice is a pure planner with synthetic tests, not a live collector or runnable operator repair tool. Trusted manifest collection (including symlink/race handling), execution-mount round-trip, write exclusion and final evidence revalidation are still required before any cutover. Existing manifest endpoints must not be assumed complete/hash-bearing without checking their contracts. No binding write or file migration was performed.

Validation: 7 targeted files / 49 tests passed; backend TypeScript no-emit passed. New planner coverage includes divergent files, directory conflicts, malformed paths, missing hashes, incomplete/stale snapshots and evidence target binding.

## Host evidence collection

`project-file-storage-collector.ts` now collects real host-root metadata and streaming SHA-256 hashes. Linux directory traversal is anchored to open directory descriptors via `/proc/self/fd`; root ancestors and entries are opened without following symlinks. Special entries and hardlinks are rejected. Entry/byte/depth limits fail instead of producing a truncated complete manifest. Opened-file identity and before/after metadata are checked for changes.

This is an internal synchronous maintenance collector, not a request-handler API; run it in a dedicated maintenance process when wiring live use to avoid blocking the server event loop. The caller must supply an authorized registered root. The scan is not atomic and cannot replace write exclusion and final revalidation. It includes hidden files without returning file contents. Worker collection and OS mount round-trip are still not connected; the planner integration test uses real host files and a synthetic matching Worker snapshot, not a real Worker.

Validation: 8 targeted files / 56 tests passed; backend TypeScript no-emit passed. Real local fixture tests cover hashes, hidden/Unicode paths, symlink ancestors/entries, hardlinks and bounded scans. No production root was scanned, no binding was activated, and no migration was applied.

## Worker evidence HTTP integration

The manifest endpoint has an opt-in `storage-preflight-v1` mode that uses the same strict collector as the host. Unlike the legacy manifest it does not silently exclude directories or symlinks. This synchronous bounded scan is disabled by default (`enableStoragePreflight`); normal Workers return maintenance-required until a dedicated maintenance execution path is configured. Limits are 2,000 entries / 64 MiB. Do not enable it on a busy production Worker.

`collectWorkerStorageSnapshot` checks persisted Worker deployment/scope/liveness, resolves transport authentication, rejects redirects, bounds response size/time, and validates the versioned complete response through the preflight contract. Legacy responses cannot masquerade as complete evidence. A real local HTTP Worker test now feeds collected metadata into comparison with the host collector. Both collectors use the same temporary fixture root in that test: this verifies HTTP integration, not independent production mounts or execution round-trip.

Validation: collector/planner/HTTP Worker/upload suites 4 files / 27 tests passed; backend typecheck passed before the maintenance opt-in addition, followed by HTTP/upload suites 2 files / 7 tests passing after the addition. No live scan, activation, migration or deployment. Maintenance runner isolation, independent Worker mount verification and authorized cutover remain unfinished.

## Isolated maintenance scan execution

The strict Worker HTTP route now awaits `collectStorageSnapshotInProcess`, not a synchronous in-process filesystem walk. A dedicated Node child receives only JSON scan input over stdin and an allowlisted LANG/TZ environment (no inherited tokens, NODE_OPTIONS or credentials). The wrapper enforces a 25-second default timeout, 4 MiB output limit and two concurrent scans per parent process, kills failed scans and exposes only bounded error codes. Maintenance opt-in remains required.

The source development entry uses tsx; the emitted runtime selects the sibling JS entry. Source subprocess execution was tested; packaging/emitted artifact inclusion and production execution still require build verification. Process separation prevents event-loop blocking but is not OS security isolation: the child retains the parent's OS user and filesystem authority, and caller authorization remains required.

Validation: full targeted group 11 files / 67 tests passed; after concurrency cap, subprocess/HTTP group 2 files / 8 tests and backend typecheck passed. Real subprocess tests cover metadata, timeout kill, sanitized failure and NODE_OPTIONS non-inheritance. No production scan, binding mutation, migration, restart or deployment was performed.

## Retired operator Worker assignment consistency

Workstation-change preview now rejects `operator-plane` before reading/writing an intent. The shared target validation also rejects it when verifying an old intent or applying one, matching the execution selector's existing retirement policy. Existing settings and files are not automatically rewritten; native Operator access remains separate from Project Worker allocation. The legacy enum remains readable for migration diagnostics.

Validation: workstation-change + execution-provider-selector suites 2 files / 37 tests passed; backend TypeScript passed. New tests cover new preview refusal and old intent smoke refusal. Apply passes the same target guard before binding INSERT; a dedicated legacy-apply regression test remains to be added. No production settings, services or deployments changed. Host resource limits, credential boundaries and lifecycle parity with the retired Worker remain separate verification work, not resolved by this patch.

## Operator retirement apply regression and native lifecycle inspection

A valid historical operator-plane intent with matching smoke receipt/binding now has an explicit apply regression: only the two SELECT FOR UPDATE queries run, no binding mutation or intent consumption occurs, and the retirement error is returned before Worker lookup. SELECT FOR UPDATE is transactional row locking, not a data UPDATE.

Native Operator lifecycle inspection: Pi tool assembly passes operations to the installed SDK's createLocalBashOperations. Its implementation supports optional timeout, AbortSignal, detached process groups and killProcessTree on timeout/abort. There is no default timeout in that SDK path. Tower's host credential wrapper forwards these options and cleans temporary credential material in finally. This establishes code-path presence, not live descendant-termination proof or equivalence to Worker cgroup CPU/memory/capacity limits. Do not add an arbitrary default timeout to long-running approved deployment jobs without defining their lifecycle contract.

## Native lifecycle executable evidence

`workbench-host-lifecycle.integration.test.ts` exercises the installed local bash executor on Linux with a real shell and ordinary sleep descendant. Explicit timeout and AbortSignal cancellation both terminate the shell and descendant (a zombie is treated as exited, not executing). The fixture uses a minimal environment without Vault data; only fixture-owned PIDs are cleaned up. `workbench-host-credential-operations.test.ts` additionally asserts unchanged timeout/signal forwarding and cancellation-error propagation through the credential wrapper.

Executed: lifecycle, host credential operations and workstation change suites: 3 files / 29 tests passed; backend TypeScript passed. This is local execution evidence, not browser Stop-button E2E or production verification. Detached/setsid escape, host shutdown, resource quotas, concurrency and cancellation during credential resolution remain outside these tests. No executor policy or production settings changed.

## Credential preparation cancellation checkpoints

Native host credential operations now check AbortSignal before lookup, after credential-name lookup, after resolution and inside the materialized-file cleanup scope before execution. Cancelled preparation never deliberately starts the base executor, and materialized files are cleaned. Tests cover pre-cancel, cancellation during resolver completion, and cancellation during file preparation with root removal. Lifecycle + host credential suites: 2 files / 20 tests passed; backend TypeScript passed. In-flight provider/DB resolution is not forcibly interrupted; cancellation is observed at await boundaries. Normal credential selection/delivery is unchanged.
