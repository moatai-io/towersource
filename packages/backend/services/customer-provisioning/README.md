# Customer provisioning service boundary

Status (2026-10-05): local contract and composed HTTP/Vault/defaults implementation. An opt-in private receiver is registered in the backend; no live receiver policy, provider credentials or database authority are enabled by this code.

## Ownership

The customer Tower runtime owns local actor/Project ACL and its workspace Credential Vault. A Control Plane caller cannot supply actor IDs, Vault scope, arbitrary policies, Team IDs or provider keys. The caller supplies customer/instance identity, immutable approval hash, operation, and a durable mutation intent ID. Enrollment operations additionally identify the approved provider kind.

`service-boundary.ts` authenticates a configured service token using timing-safe comparison, validates the instance binding and approval, and consumes the mutation intent through a mandatory atomic durable authority port. No consumed intent is released on failure.

`runtime-authority.ts` independently loads local instance identity and an immutable approved runtime record, checks expiry/revocation and local access, and delegates atomic intent authorization to the trusted store. The store must recheck current approval/ACL inside its transaction. The port interface alone is not evidence that durable persistence exists.

`enrollment-handler.ts` selects provider policy only from the approved local store, delegates issue-and-store, and independently verifies secret-free provider/Vault readback. Unknown issue outcome does not permit replay.

`smoke-handler.ts` bounds request size, validates fixed smoke inputs, and exposes usage/estimate/execute contract handlers. Requests are approval-bound; execute additionally requires a durable intent. Caller-selected Team IDs and arbitrary models/prompts are rejected. Responses contain only strict secret-free fields. Usage ports derive scope from the locally owned virtual key. Execute ports must enforce/reserve Team and smoke budgets before issuing the paid request, not merely reject excessive spend after execution.

## Not implemented / not enabled

- Production HTTP router registration and network exposure.
- Production registration/application of the candidate approval/intent schema and administrator approval publication. `intent-schema.candidate.sql`, `pg-runtime-store.ts`, `pg-intent-store.ts` and `pg-locked-authority.ts` provide local candidates; they are not automatically selected or applied.
- Live local instance identity attestation. `local-vault-access.ts` reuses canonical actor/Project/workspace ACL; the candidate PostgreSQL mutation fence locks/rechecks approved runtime, active admin and existing Project.
- Zuplo and LiteLLM management issue-and-store adapters for a customer runtime.
- Live LiteLLM pricing source, provider accounting freshness (`summary.observed_at`) and approved budget snapshot publication. `litellm-smoke-ports.ts` reuses canonical virtual-key, usage and exhaustive turn-spend clients, fixes `tower_root_turn_id` metadata, bounds responses and requires pricing/reservation ports. Candidate `pg-smoke-ledger.ts`, `pg-smoke-reservation.ts` and `smoke-ledger.candidate.sql` implement local reservation/reconciliation; no live pricing or provider snapshot is guessed.
- Live service credentials, customer bindings and deployment configuration.

Until all these pieces are supplied and reviewed, handlers cannot be represented as an operational enrollment service. No automatic authority or service identity is derived from environment alone. Missing configuration fails closed.

## Management credential boundary

The existing Zuplo issuer resolves a management Credential from its local Project Vault. Do not wire it directly into a customer runtime by transferring a global management key. A central issuance authority and a customer-side authenticated delivery/Vault store require a reviewed cross-runtime protocol. The current enrollment ports deliberately do not select a management credential or remote delivery target implicitly.

## Candidate durable storage

Approval and intent rows are prepublished by a separate authority. `pg-intent-store.ts` cannot insert new intents: it performs a single conditional UPDATE with the exact identity, hash, operation/provider and actor/Project fields. The mandatory locked-authority callback rechecks current approval and active admin in the same transaction. Unknown COMMIT outcomes fail closed; callers must read back before doing anything else. No production role grants or schema migration registration are provided.

An isolated PostgreSQL fixture verifies two concurrent consumers have exactly one winner, replay is denied, disabled actor/revoked approval leave a fresh intent unconsumed, reservation is single-winner and reconciliation is single-use. Full reservation accounting stays held after reconciliation until an exhaustive provider snapshot can explicitly absorb it; missing snapshot integration deliberately overblocks rather than understates Team spend. This proves the candidate adapter against PostgreSQL, not production authorization publication or role isolation.

## First-connection inference — 2026-10-05

- `liteLlmEnrollmentPorts` connects the existing enrollment service to automatic central Team/key issuance. It resolves the exact immutable approval before each action and uses the original delivery intent for readback. Later readback independently verifies the central Team and key policy before accepting the customer Vault receipt. The central deployment must still supply an attested serving management client and durable approved-policy resolver; this interface is not operational registration.
- `customerDeliveryTransport` delivers the virtual key directly to the customer receiver, not through a Control Plane response. It requires a deployment-selected HTTPS target, disables redirects and bounds receipt bytes. Unknown outcomes never trigger a retry.
- `customerVaultReceiver` stores one customer Vault key reference, uses the canonical `upsertApiKeyCredential` return row's server-owned `secret_name` (never a fabricated caller name), invokes `configureCustomerLiteLLMFromVault`, and activates the existing in-process model reload path. Readback checks both Vault and provider binding and does not hide runtime activation failure. Post-store failure retains the Vault row for explicit recovery; reissuance is forbidden.
- `customer-delivery-listener.ts` is registered by `packages/backend/index.ts`, disabled unless an explicit policy is selected. It binds only `127.0.0.1`, separate from the public API, and closes during backend shutdown. This is another listener in the same Tower process, not a new system service or public route.
- Required installation inputs are `TOWER_CUSTOMER_DELIVERY_POLICY`, `TOWER_CUSTOMER_DELIVERY_PORT`, `TOWER_CUSTOMER_DELIVERY_TOKEN` and `TOWER_INSTANCE_ID`. The policy is a root-owned, non-writable, non-symlink file in a root-protected directory, with exactly `{schemaVersion:1, delivery:ApprovedDelivery, inferenceBaseUrl:string}`. There is no credential value in this policy. The receiver token must be securely injected, never embedded in JSON, source or receipts.
- The installed customer instance ID must match a fresh durable approval. PostgreSQL readiness and separately approved `intent-schema.candidate.sql` installation/publication are required. Startup neither applies the schema nor creates an actor, approval, intent or provider key. There is no SQLite fallback.
- First connection maps Core and Lite to `litellm-responses/~deepseek/deepseek-pro-latest` and makes `gpt-6.1-sol`, `~deepseek/deepseek-pro-latest` and `z-ai/glm-5.3` visible only if the authenticated Team catalog contains them. Subsequent administrator settings and model visibility authority remain unchanged by reentry.

### Deployment boundaries still open

A local passing test does not demonstrate first-customer AI connectivity. Before a live run, select and attest the existing serving Router path, approve the new exact model-policy snapshot, install the protected receiver policy/secure token/identity and private transport, publish durable authority and a fresh intent, and deploy the exact reviewed revision. Paid AI and usage verification remain separate acceptance gates. Existing transport failures, consumed intents or old approvals are not replay authority.

## Local verification

Unit tests cover service authentication, revoked/expired approval, wrong instance, missing intent, replay rejection, provider mismatch, strict output and paid-request ambiguity. A private Control Plane workspace fixture also runs its smoke proxy against this handler over local HTTP. The composed tests additionally exercise enrollment HTTP → central management adapter → direct customer delivery HTTP → Vault reference → first defaults → runtime activation and readback. A real local HTTP listener test covers raw bounded bodies and loopback-only access. A separate integration test uses the actual canonical Vault upsert/readback code with fixture persistence, confirming the generated storage reference is reused and a mismatched resolver reference is denied. These remain local fixture tests, not a production or signed-in customer E2E test.

## Opaque Responses ID and retained intent contract (local candidate)

Provider response IDs are opaque, exact-match values of 1–2048 ASCII characters from `[-A-Za-z0-9_:./=+]`. Do not truncate or hash the value used for reconciliation. Whitespace, controls, query delimiters, and oversized IDs fail closed before ledger reconciliation. Intent/team identifiers retain their existing narrower validation.

The Responses body keeps provider-safe `metadata.tower_root_turn_id` separate from `litellm_metadata.spend_logs_metadata.tower_root_turn_id`. The latter matches the provider spend-metadata allowlist. Usage readback must scope the stored intent by the authenticated key and team; a customer report alone is not independent evidence. The exact response sentinel, completed status, request ID, intent, and bounded cost remain required.

These are local candidate contracts, not evidence of provider HTTP persistence or deployment. A consumed attempt with missing response/intent evidence remains unresolved; never rewrite spend rows or release a reservation merely because a later fixture passes.
