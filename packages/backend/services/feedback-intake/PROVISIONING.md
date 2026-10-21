# Feedback enrollment preparation

## Scope

`provision-plan.ts` and `provision-plan-cli.ts` are **plan-only** operator tools, not an enrollment executor. They never open environment files, connect to a database, contact a customer, read an App key, generate tokens or modify settings. `--apply` and all other unsupported arguments fail before stdin is read. This narrow design avoids introducing a general-purpose remote secret-writing tool without a reviewed transport/secret source.

Input is a bounded (16 KiB), secret-free JSON evidence document on stdin. Do not send a token, PEM, database URL, environment contents or token digest to this command. Unknown fields are rejected; errors are fixed codes and do not echo the input.

```bash
node --import tsx packages/backend/services/feedback-intake/provision-plan-cli.ts --dry-run < reviewed-evidence.json
# Omitting --dry-run has exactly the same read-only behavior.
```

`ProvisionEvidence` in `provision-plan.ts` defines the strict input schema. Synthetic examples are in `provision-plan.test.ts`. Operator evidence includes expected/observed central host, database/role, customer host/backend UID, exact revision, schema hash and comparison result, backup confirmation, env file metadata/preimage hash, allowlisted key presence/equality and a secret-free enrollment receipt phase.

## What the planner verifies

- Expected and observed identities must match. Central and customer hosts must differ. The central origin must be an HTTPS origin without userinfo, path, query or fragment.
- The reviewed central schema hash must match this implementation. Both tables must be present, the operator must report a verified backup and matching live definition. This command **does not itself inspect live evidence** (`evidenceVerifiedByPlanner=false`).
- The customer env file must be reported as canonical, regular, single-link, backend-owned, mode 0600, under trusted parent directories. Duplicate or conflicting managed keys are rejected.
- Only `TOWER_FEEDBACK_CLIENT_TOKEN`, `TOWER_FEEDBACK_CLIENT_ENABLED`, `TOWER_FEEDBACK_INTAKE_ORIGIN` are allowed in the planned append operation. Unrelated env bytes must remain unchanged. Existing managed values are never replaced or rotated.
- A new enrollment refuses existing tenant/configuration. A resumed enrollment must carry the same `planHash`, confirmed identical token in memory and matching tenant configuration. Missing central rows, contradictory receipts and partial env key sets stop for review.

`planHash` binds stable target identity/revision/schema and remains stable across resume. `evidenceHash` separately binds the entire submitted observation, including env preimage and receipt state. Human review must cover **both hashes**; an old stable plan hash alone must never authorize writing over a changed env file. Evidence strings/booleans are assertions, not proofs or authorization tokens.

## Future apply contract — not implemented here

The parent operator must separately review a narrowly scoped provisioning adapter before actual writes. It must enforce the following at execution time, not merely trust planner input:

1. Verify live identities and the exact central schema definition, backup receipt and env preimage. Acquire an exclusive operation lock. Refuse stale evidence or an unapproved plan/evidence hash.
2. Receive a CSPRNG token through protected stdin only. Never accept a token in argv, print it, store it in a receipt, generate a replacement while resuming, or request chat re-entry. Token generation/provisioning is a separately approved operator operation.
3. Compute SHA-256 over `tower-feedback-token:v1:${token}`. Insert the tenant with parameterized SQL and no `ON CONFLICT` update. Compare existing rows only in a reviewed resume with the same receipt and token.
4. Append exactly the three allowlisted customer keys. The token must satisfy the existing base64url token contract; origin and boolean must be validated. Never evaluate arbitrary dotenv text as shell while editing it. Preserve unrelated bytes and refuse duplicate/export/continued/otherwise ambiguous managed assignments rather than guessing.
5. Require trusted parent ownership/ACL and no symlinks. Create an exclusive private backup before writing; it contains secrets and belongs outside the repository/workspace. Write an exclusive same-directory 0600 temporary file, fsync, recheck identity/preimage under the lock, rename atomically and fsync the directory. A lock cannot stop uncooperative same-UID/root writers, so operational isolation is also required.
6. Persist a secret-free receipt before and after each stage. Record plan/evidence hashes, exact identity, stage, timestamp and file metadata—not token/digest/env bytes. On crash after a write but before its receipt, reconcile actual state before continuing.
7. Do not deploy or restart from the provisioning adapter. The separately approved Nix/PM2 rollout path owns activation.

## Partial failure decisions

| Durable / observed state | Next action |
| --- | --- |
| No receipt, no tenant or managed env keys | Plan central insertion after fresh approval. |
| Prepared receipt, matching tenant exists, env absent | Treat a possibly completed insert as completed; reuse the same token to prepare customer installation. |
| Central-enrolled receipt, matching tenant and all customer keys already present | Verify actual configuration and backend; do not rewrite the env file. |
| Verified receipt and matching tenant/customer | Return complete; no mutation. |
| Token unavailable, receipt mismatch, conflicting values, partial env keys or missing tenant after enrollment | Stop. Do not rotate, overwrite, delete, blindly retry or mint a new token. |

No actual protected backup, env atomic-write routine, DB insert or SSH transport is claimed by these tests. The tests validate the planner's decisions and CLI refusal boundary, not operational side effects.

## Validation

```bash
FEEDBACK_DISPOSABLE_PG_TEST=1 npx vitest run \
  packages/backend/services/feedback-intake \
  packages/backend/mcp/issue-server.feedback.test.ts \
  packages/backend/index.candidate-passive.source.test.ts --maxWorkers=2
npx tsc --noEmit -p tsconfig.backend.json
```

The optional PG suite uses only a disposable local cluster. The planner suite uses synthetic evidence and invokes the CLI with synthetic input; it never reads live credentials or environment files.
