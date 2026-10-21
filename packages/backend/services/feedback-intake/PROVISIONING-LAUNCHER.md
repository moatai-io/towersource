# Production feedback launcher and receiver

This supersedes the **unimplemented launcher/receiver** caveat in `PROVISIONING-APPLY.md`. Production connector, bounded SSH stdin transport, fixed receiver protocol, review-package generation and explicit apply CLI are now implemented. No production installation or mutation has been performed by implementation tests.

## Shipped entrypoints

- `provision-launcher-cli.ts`: operator CLI. Requires explicit protected config; defaults to a read-only review package. `--apply` requires a saved package and exact review hash.
- `provision-launcher.ts`: direct approved PostgreSQL connector (Unix socket or certificate-verified TLS), actual schema/backup/customer observation, review hash and target validation, and the previously implemented apply API.
- `provision-ssh.ts`: real `spawn`-backed SSH transport. Explicit identity/known-hosts; no shell interpolation or inherited SSH config/agent. Remote execution is `/usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 <pinned-node> <pinned-receiver> --binding <protected-binding>`.
- `provision-receiver-cli.ts` / `provision-receiver.ts`: fixed inspect/append receiver. Host is observed with `os.hostname()` and UID with `geteuid()`. Protected local binding fixes revision, env path, backup directory, plan hash, preimage and origin. Incoming caller cannot choose another target or operation.
- `provision-runtime.ts`: strict request/response schemas, bounded IO, clean subprocess environment, release-manifest and own compiled-file location checks.

The legacy plan CLI remains read-only. The old `/usr/local/libexec/tower-feedback-customer-append` sketch is **not used** by this transport, and no preinstalled custom libexec command is assumed.

## Exact release packaging

The existing backend TypeScript build includes new production `.ts` files. `flake.nix` copies compiled `dist/backend` into `$out/lib/tower/dist/backend`, while its runtime dependency tree supplies `pg`, `zod` and other imports. No custom global tool installation is required.

For the newly committed, approved revision, use the actual promoted closure:

```text
APP=/nix/store/<exact-tower-app-closure>
MANIFEST=$APP/share/tower/release-manifest.json
LAUNCHER=$APP/lib/tower/dist/backend/packages/backend/services/feedback-intake/provision-launcher-cli.js
RECEIVER=$APP/lib/tower/dist/backend/packages/backend/services/feedback-intake/provision-receiver-cli.js
NODE=/nix/store/<node-runtime-closure>/bin/node
```

Resolve NODE from the promoted runtime's wrapper/runtime metadata, not from a guessed store hash. Both paths must exist on each intended host; the receiver path must be inside a Nix store app closure. CLI entrypoints check that their own directory corresponds to the supplied manifest's exact closure root. The receiver independently checks the manifest `sourceRev` against the bound approved revision. A source-tree `tsx` invocation is deliberately not a supported production bypass.

The manual SQL remains outside automatic migrations and is **not assumed to be copied by TypeScript**. Extract it from the same exact committed revision, verify its fixed hash, and keep the approved source path in operator config. Its application remains a separately approved operation.

Before cutover, run the normal exact-revision build/preflight. Verify the two compiled entrypoint files in the signed/prefetched closure. Config creation, closure transfer and normal backend deployment are operational approval steps, not missing code generation.

## Receiver binding (non-secret JSON, mode 0600)

Prepare the binding before generating a launcher review package. The planHash is derived offline using `prepareProvisionPlan` from the exact central/customer/tenant/revision/schema target. It does not depend on token, schema backup path, SSH binding hash or mutable env state, so no circular hash dependency exists. Its preimage must come from a secret-safe customer-local checksum/inspection of the selected env file; no env contents are copied into the model.

```json
{
  "version": 1,
  "revision": "<40-character-approved-revision>",
  "manifestPath": "/nix/store/<app>/share/tower/release-manifest.json",
  "host": "customer.example.com",
  "uid": 1000,
  "envPath": "/srv/tower/backend/.env",
  "backupDir": "/var/lib/tower-feedback/customer-backups",
  "planHash": "<64-character-stable-target-hash>",
  "preimage": "<64-character-current-env-sha256>",
  "origin": "https://feedback.example.com"
}
```

`host` is the actual OS hostname, not necessarily the SSH DNS target. Binding and backup directory are owned by the customer backend UID. The CLI runs as that same UID. Configuration parents must be trusted, root/current-UID-owned and not group/other writable. Private files are regular/single-link/canonical 0600, directories 0700 where required. ACL and same-UID process isolation remain explicit operational checks.

## Operator config (non-secret JSON, mode 0600)

All fields are required except socket passwordFile. Unknown fields fail closed. Secret values never appear here; only explicit protected secret-file paths are accepted.

```json
{
  "version": 1,
  "revision": "<approved-revision>",
  "manifestPath": "/nix/store/<app>/share/tower/release-manifest.json",
  "centralHost": "central.example.com",
  "customerHost": "customer.example.com",
  "customerUid": 1000,
  "envPath": "/srv/tower/backend/.env",
  "origin": "https://feedback.example.com",
  "tenant": { "id": "customer-a", "titlePrefix": "Customer A", "label": "customer:customer-a" },
  "pg": {
    "mode": "tls", "host": "database.example.com", "port": 5432,
    "database": "tower", "user": "tower",
    "passwordFile": "/var/lib/tower-feedback/operator/pg-password",
    "caFile": "/var/lib/tower-feedback/operator/pg-ca.pem"
  },
  "ssh": {
    "target": "backend@customer.example.com",
    "knownHosts": "/var/lib/tower-feedback/operator/known_hosts",
    "identityFile": "/var/lib/tower-feedback/operator/ssh-identity",
    "node": "/nix/store/<node>/bin/node",
    "receiver": "/nix/store/<app>/lib/tower/dist/backend/packages/backend/services/feedback-intake/provision-receiver-cli.js",
    "bindingPath": "/var/lib/tower-feedback/customer-binding.json",
    "bindingHash": "<sha256-of-exact-binding-file-bytes>"
  },
  "secretDirectory": "/var/lib/tower-feedback/operator/enrollment",
  "backupFile": "/var/lib/tower-feedback/operator/before-feedback.dump",
  "sourceSql": "/var/lib/tower-feedback/operator/exact-feedback-schema.sql",
  "reviewedSchemaFingerprint": "<independently-reviewed-live-definition-fingerprint>",
  "reviewedBackupSha256": "<verified-backup-sha256>"
}
```

Socket alternative:

```json
{ "mode": "socket", "host": "/run/postgresql", "port": 5432,
  "database": "tower", "user": "tower", "socketOwnerUid": 100,
  "passwordFile": "/var/lib/tower-feedback/operator/pg-password" }
```

Socket owner UID is the reviewed PostgreSQL daemon UID, not assumed to be the backend UID. Socket path and ancestors must satisfy the strict trusted-directory check. Deployments with group-writable/untrusted socket ancestry must choose a separately configured certificate-verified TLS endpoint or approved filesystem hardening; the launcher does not weaken checks automatically. Socket passwordFile is optional for peer-auth setups. TLS uses explicit CA and certificate/hostname verification, never sslmode=disable or rejectUnauthorized=false. Password callback prevents ambient PGPASSWORD and `.pgpass` fallback.

Known-hosts and SSH identity files must be explicit private 0600 files; SSH uses `-F /dev/null`, `IdentitiesOnly=yes`, `IdentityAgent=none`, `StrictHostKeyChecking=yes`, and no forwarding. Host enrollment/fingerprint approval is an operator action. Never use accept-new or retrieve key values into chat. Existing approved credentials can be materialized directly into these protected files by the authorized operator; no user chat re-entry is required.

## Approval and execution

Only after the normal operational approval to provision configuration/backup/binding and deploy the exact closure, execute a read-only review:

```bash
# Run as the exact approved operator UID. Do not set NODE_OPTIONS or inherit provider env.
/usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 \
  "$NODE" "$LAUNCHER" --config "$CONFIG"
```

The launcher itself makes no file writes in this mode: it does not create review files, locks, tokens, receipts, backups or tenant rows. Its stdout is a bounded secret-free approval package containing `configHash`, `planHash`, `evidenceHash`, `schemaFingerprint`, `backupSha256`, `evidence` and `reviewHash`. SQL uses read-only mode. Ordinary OS access metadata/DB connection logs are outside the application's write guarantee.

Save the displayed package to an operator-owned 0600 review file **as a separately explicit file operation** and present the exact reviewHash and scope to the user. The review hash binds all connection paths/targets through the exact config bytes as well as the target/evidence/schema/backup package. Any config change requires a fresh review. Whitespace-only config changes intentionally invalidate it.

```bash
# No mutations: recheck an existing review, including partial enrollment recovery.
/usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 \
  "$NODE" "$LAUNCHER" --config "$CONFIG" --review "$REVIEW"

# Only after explicit approval of this exact review hash and operational scope:
/usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 \
  "$NODE" "$LAUNCHER" --config "$CONFIG" \
  --apply --review "$REVIEW" --approve "$REVIEW_HASH"
```

Apply revalidates actual state before using the prior adapter. A fresh dry-run refuses already enrolled tenants; use the original review for dry-run/resume instead. The token never appears in these commands. CLI errors are fixed codes; transport stderr and oversized/unexpected response fields are discarded. The receiver's strict response can contain only status, binding hash and a secret-free snapshot. Both local and remote subprocess environments are cleared.

Completion reports `customer-configured` and `restartPerformed=false`. This does not start the backend, activate GitHub delivery or assert that the synthetic issue exists. Normal Nix/PM2 restart and one authorized real smoke remain operational steps.

## Test coverage and remaining gates

`provision-launcher.e2e.test.ts` creates a disposable PostgreSQL cluster and spawns a launcher fixture process, which invokes the real transport protocol through stdin into a **separate receiver process**, modifying only temporary customer files. It tests review → wrong approval refusal → apply → process restart/read-only reconciliation → tampered binding refusal. The injected transport substitutes local subprocesses for actual SSH; it does not claim SSH authentication/remote filesystem verification. The fixture entrypoint cannot be selected by production SSH validation or production CLI config.

`provision-runtime.test.ts` verifies clean subprocess env, strict SSH argv, bounded output, fixed errors and immutable location checks. No runtime test bypass is exposed as a production CLI flag.

All implementation layers required for this one-tenant enrollment are now present. Remaining work is operational: approval of exact new revision/review/schema, private file/directory/credential/binding provisioning, signed closure build/transfer, real TLS/SSH connectivity preflight, backup/schema application, env compatibility checks, normal activation, labels and one authorized feedback smoke. The tests do not perform any of those live actions.
