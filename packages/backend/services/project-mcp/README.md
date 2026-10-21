# Project MCP gateway and Agent-shared OAuth

This module owns `.tower/mcp/manifest.json`, deferred MCP search/call execution,
Agent-scoped connection metadata and SDK OAuth intents. It does not own session
selection policy: `ProjectMcpLoadOptions.isServerAllowed` supplies the live checker
from `services/session/session-mcp-selection.ts`.

## Accepted account boundary

An OAuth connection belongs to one Agent/Project. The external account used by
the manager is shared with that Agent's permitted execution users. It is **not**
personal OAuth and is not organization-wide OAuth. The UI must show the shared
account warning and send `acknowledgeSharedAccount: true` before auth start.

Management uses fresh project access **and** Credential management authority.
Execution independently rechecks the active user, active project, membership or
scoped Operator access, registered root, read-only restrictions, current manifest,
and session opt-out before discovery/cached search/call. Membership revocation
is not bypassed by historical project ownership. An in-flight external call is
not cancelled by a later selection toggle.

## HTTP contract and mounting

Mount `routes/project-mcp-api.ts`'s default router under `/api` **after** existing
user authentication. Mount the named `publicProjectMcpOAuthRouter` under `/api`
**before** user authentication: top-level browser navigation cannot carry Tower's
local-storage bearer token. The callback uses a random 256-bit, hash-stored,
ten-minute, single-use intent bound to actor/project/server/URL and rechecks the
actor's current management authority. PKCE is implemented by the MCP SDK.

- `GET /projects/:projectId/mcp/connections`: `{connections, canManage, authScope: "agent", sharedAccountNotice}`.
- Each connection: `{id, name, displayName, description, url?, enabled, authType, authScope, status}`.
- `POST /projects/:projectId/mcp/connections`: `{name, displayName?, url, authType: "oauth" | "none"}` → `201 {connection}`.
- `POST /projects/:projectId/mcp/connections/:name/auth/start`: `{acknowledgeSharedAccount: true}` → `{authorizationUrl, authScope, sharedAccountNotice}`.
- `DELETE /projects/:projectId/mcp/connections/:name/auth`: `{disconnected: true}` (local disconnection; not provider-side revocation).
- `DELETE /projects/:projectId/mcp/connections/:name`: `{removed: true}`.
- `GET /projects/:projectId/mcp/oauth/callback?state=…&code=…`: fixed redirect `/?mcpAuth=connected|error` with no-store/no-referrer.

`connected` means authentication is saved, not that provider calls were live
verified. `configured` is a non-OAuth manifest entry. Existing curated Agent Store
fallback behavior remains in the gateway; manifest listing is not a claim that a
fallback credential exists. Names are stable lowercase gateway-compatible IDs.

## Security and storage

Migration `235_project_mcp_oauth.sql` adds connection references and OAuth intent
metadata only. Client information, tokens and PKCE verifiers reuse the existing
AES-GCM `secret_store` boundary; they are never returned in connection DTOs,
model context, manifest JSON or logs. Secret owner identity remains the manager
who authorized the external account; Agent ACL controls use by other members.
Runtime refresh/invalidation uses ciphertext compare-and-swap with Vault-encrypted staging: stale updates fail closed rather than overwrite another refresh. Token reads reload the current bundle; successful token invalidation atomically marks the connection disconnected. This protects storage races but does not serialize provider-side refresh requests (providers with single-use rotation may require reconnect after concurrent refresh). Disconnect/new auth intent invalidates pending callback promotion. Expired intent
secrets are cleaned on the next authorization start.

HTTPS/443 public destinations only: URL credentials, private/reserved IPv4/IPv6,
local hostnames and redirects are rejected. DNS answers are checked and pinned
in the HTTPS socket lookup to resist rebinding. The same fetch boundary covers
MCP transport, OAuth discovery, registration, token exchange and refresh.

Manifest writes preserve unrelated fields, serialize writes in this backend
process, use mode-0600 atomic rename and reject symlinked descendants/oversized
manifests. This is not a cross-process lock against out-of-band file editors.

## Initial supported vertical slice and limitations

The management UI registers streamable-HTTP public MCP endpoints, with either no
OAuth or SDK authorization-code/PKCE OAuth using dynamic client registration.
Pre-registered client secrets, personal/team OAuth, arbitrary management-UI stdio
commands, private MCP hosts and custom ports are intentionally not supported.
Provider-side token revocation, scheduled expired-secret cleanup, full refresh-operation
serialization across concurrent backend processes, and a live tool-catalog probe
are not implemented. Runtime reconnect never redirects or creates a new client;
users reconnect from Agent settings when interactive authentication is required.

## Evidence and owners

- Loader: `project-mcp-loader.ts`, `project-mcp-loader.test.ts`.
- Live opt-out/cache regressions: `session-selection-gateway.test.ts`.
- Account/state/PKCE: `project-mcp-oauth.ts`, `project-mcp-oauth.test.ts`.
- Network boundary: `project-mcp-network.ts`, `project-mcp-network.test.ts`.
- Manifest preservation: `project-mcp-manifest.ts`, `project-mcp-manifest.test.ts`.
- ACL: `project-mcp-access.ts`, `project-mcp-access.test.ts`.
- API: `../../routes/project-mcp-api.ts`, `../../routes/project-mcp-api.test.ts`.

Tests mock database/provider OAuth and are local evidence only. A migration
file, passing unit tests, or a saved auth token is not deployment/live verification.

## Composer integration and verification

`ComposerCapabilitiesMenu.tsx` replaces the composer upload-only entry with file,
skill and MCP connector navigation. Skill selection inserts an existing canonical
slash command and preserves the draft; it does not attach the skill body.
`ComposerConnectors.tsx` reads the Agent catalog and session selection. Connection
management explicitly confirms shared-account login and destructive actions.
`McpOAuthNotice.tsx` consumes the fixed callback result marker without exposing
provider errors or tokens.

The public callback router is mounted in `routes/api.ts` before authentication;
management and session selection routers are mounted after authentication.
Apply migrations `234_session_mcp_selection.sql` and `235_project_mcp_oauth.sql`
through the approved deployment path before enabling this feature. Migration
application and real-provider OAuth verification were not performed during local
implementation. New authenticated remote connections currently require dynamic
client registration and public HTTPS on port 443; redirects are rejected.

Local integrated verification: 17 test files, 149 passing tests and 9 existing
skipped tests; full typecheck passed. The final production build also passed. No browser
visual verification or provider authentication is implied by these results.
