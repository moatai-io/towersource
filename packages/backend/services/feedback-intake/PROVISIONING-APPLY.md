# Narrow feedback enrollment apply adapter

This supplements `PROVISIONING.md`. The earlier planner remains plan-only. Actual write routines now live in independent `provision-apply.ts`, `provision-customer.ts`, and `provision-files.ts`. Nothing is mounted on the backend, exposed as an MCP tool, or automatically executed.

## Implemented effects

- `pgCentralAdapter`: directly observes database/role, full feedback columns/constraints/index fingerprint and existing tenant. Writes one parameterized `INSERT` into `public.feedback_tenants`, never upserts, updates, rotates, deletes or applies schema.
- `localCustomerAdapter`: directly verifies bound host/UID, canonical env file, ownership/mode/single link and trusted ancestors. Appends only CLIENT_TOKEN, CLIENT_ENABLED and INTAKE_ORIGIN while preserving all existing unrelated bytes. Creates a private backup, exclusive same-directory temporary file, fsyncs, checks the preimage again, atomically renames and fsyncs the directory. Existing identical configuration is read-only reconciliation; conflicting/partial configuration is refused.
- `provisionFeedback`: default dry-run observes actual state without generating a token, creating locks/receipts or changing rows/files. Explicit apply persists a secret-free prepared receipt, generates 32 CSPRNG bytes encoded as base64url, stores the token in a dedicated 0600 secret file before any cross-system mutation, inserts centrally, appends customer configuration through stdin bytes, and advances the durable receipt only after readback.
- Token digest is exactly SHA-256 of `tower-feedback-token:v1:${token}`. Tokens never enter argv, returned results, errors or receipts. Secret stdin buffers are cleared after transport returns. JavaScript string copies are not guaranteed to be erased from process memory.
- `fileBackupAndSourceVerifier` hashes explicit protected backup and exact source SQL files. It does not create backups or attest that restore testing happened.

## Operator API (not automatic CLI discovery)

The API accepts CLI-style arguments but does **not** discover a production database, environment source, SSH target or secret directory. A reviewed host-bound operator launcher must supply the dependencies. The existing `provision-plan-cli.ts --apply` still fails; it has not been silently converted into a writer.

```ts
// Generic integration shape. Never put credentials in this source file.
const adapter = pgCentralAdapter(existingApprovedPgClient, observeCentralHost);
const customer = localCustomerAdapter({
  host: approvedCustomerHost,
  uid: approvedCustomerBackendUid,
  envPath: approvedCustomerEnvPath,
  backupDir: approvedCustomerPrivateBackupDirectory,
  observeIdentity: observeActualCustomerHostAndUid,
});
const deps = {
  central: adapter,
  customer, // Remote transport must preserve the same inspect+stdin contract.
  secretDirectory: approvedCentralPrivateSecretDirectory,
  verifyBackupAndSource: fileBackupAndSourceVerifier(approvedBackupPath, exactSourceSqlPath),
};
const result = await provisionFeedback(originalEvidence, {
  planHash: reviewedPlanHash,
  evidenceHash: reviewedEvidenceHash,
  schemaFingerprint: independentlyReviewedSchemaFingerprint,
  backupSha256: reviewedBackupSha256,
}, deps); // Dry-run. No token generation or writes.

// Separate explicit user approval is mandatory before passing these args:
const args = ['--apply', '--approve-plan', reviewedPlanHash,
  '--approve-evidence', reviewedEvidenceHash];
```

Do not use two local adapters on the central host to impersonate a customer. `observeIdentity` and the PG connection are trusted operator dependencies, not model arguments. Production remote inspect must be performed on the bound customer. Fake dependencies are used only in tests.

## Evidence and schema gate

Apply refuses bare planner booleans as sufficient evidence. Immediately before effects it rechecks:

- actual central host, database, role, full schema fingerprint;
- backup and SQL source byte hashes;
- actual customer host, backend UID, env path and env preimage/equality;
- existing tenant identity, active flag and same namespaced token digest;
- original reviewed plan/evidence hashes and persisted approval identity.

The expected schema fingerprint must be independently reviewed against the approved SQL, preferably generated in a disposable PostgreSQL instance of the same major version. Do not read the current live fingerprint and declare it approved without comparing its definition. This code fingerprints constraints/defaults/indexes, so PostgreSQL formatting differences may require review; do not weaken the check to table-count-only. The central connection must remain pinned to its verified server, with TLS/host binding provided by the approved connector. The source hash is the existing fixed reviewed schema hash.

## Secret store and permissions

Create the operator secret/receipt directory and customer backup directory separately under approved paths, mode 0700, owned by the running backend/operator UID. Files are single-link, no symlinks, mode 0600. Ancestors may be root or current UID owned but must not be group/other writable. ACLs, same-UID process isolation and operational control over configuration writers require separate review. Tests replace the ancestor checker only to operate in temporary fixture paths; production must not bypass it.

The customer adapter runs as the intended backend UID. It intentionally cannot silently change ownership as root on behalf of another UID. Environment parser support is conservative: single-line plain/quoted assignments, no expansion/backticks/backslash, no multiline, no ambiguous managed export/duplicate/partial keys. A rejected production dotenv file requires a separately reviewed compatibility change, not bypassing the parser or rewriting unrelated values.

Secret backup and token files are never workspace artifacts. Do not read them into a model context. They remain for crash recovery; this adapter does not implement deletion or automatic cleanup.

## Durable recovery contract

Receipt fields are version, planHash, evidenceHash, approvalHash and phase. The token is a **separate protected file**, never receipt content. Resume passes the original evidence and exact approval; the adapter reconciles actual rows/files directly rather than trusting newly asserted resume booleans.

| Failure window | Behavior on resume |
| --- | --- |
| Before prepared receipt | Fresh run can proceed after direct revalidation. |
| After prepared receipt but before persisted token | Refuse; do not automatically generate another token. Operator reconciliation is required. |
| After persisted token, before central insert | Reuse stored token and insert once. |
| DB commit succeeds but response/receipt write fails | Compare existing tenant to stored token/identity; do not insert or rotate again. |
| Transport fails before customer write | Reuse stored token and retry the same append after direct checks. |
| Customer rename succeeds but ACK/receipt update fails | Read back matching managed values; do not rewrite or append again. |
| Receipt says configured but env/tenant missing or changed | Refuse and preserve evidence. |
| Token file missing/tampered, conflicting backup/row/env | Refuse; never replace it with a new credential. |
| Hard crash leaves operation lock | Fail closed. Operator must establish no active writer and reconcile state before explicitly removing the stale lock. |

Lock directories coordinate only cooperative operations. Uncooperative root/same-UID writers and host administrators remain inside the trust boundary. No automatic lock breaking, destructive rollback or receipt deletion is implemented.

## SSH boundary

`feedbackSshSpec` emits a validated argv specification, not an SSH execution. The exact `user@host` and known-hosts path are validated, host-key checking is strict, agent forwarding/forwardings are disabled, and the only remote command is the fixed `/usr/local/libexec/tower-feedback-customer-append`. No token, env path or script fragment is interpolated into a shell command. The generated JSON bytes belong in stdin only; no `echo token`, `sh -c`, `exec` string or stderr echoing.

A host-bound receiver must be separately installed/reviewed and must verify its own host/UID/path before invoking `localCustomerAdapter.appendStdin`. The matching remote inspect transport is also required. **No production SSH launcher/receiver installation or end-to-end remote transport is shipped or performed by this local adapter work.** Receiver responses must be fixed status/secret-free snapshots; nonzero/timeout results must be sanitized to the fixed provisioning error.

## Validation and remaining activation gates

Unit tests run real atomic writes/backups/receipts only in fresh disposable directories, with fake central/transport dependencies. PG tests create a new isolated cluster, exercise real INSERT/unique conflict and detect constraint drift. No live credentials, database, customer filesystem or GitHub are used.

Remaining gates: new exact committed revision and human approval; reviewed production connector/host-bound SSH inspect+receiver wiring; central backup/SQL application; schema fingerprint review; protected directory and ACL setup; `.env` parser compatibility via secret-safe local checking; normal Nix/PM2 rollout; labels; one approved real Pi/GitHub smoke. A configured receipt means enrollment files/row were verified, **not** that a backend restarted or a GitHub issue was delivered.
