---
title: "Agent Authority and Connections"
icon: "🔐"
order: 9
---

# Agent authority and connection operations

## Scope and principle

Users access Agents; Agents execute within their own Project, tools, and Connections. An Agent does not implicitly inherit the requester's personal Google login or platform administrator privileges.

This guide describes the Agent-owned authority implementation. Applicable code, database migrations, and execution configuration must be deployed together. Documentation updates do not establish deployment status.

## Roles

| Role | Responsibility | Not automatically granted |
|---|---|---|
| member | Request work and manage files and Agent Connections where actual Project write access permits it. | Writes in read-only Projects, other Project access, platform administration. |
| operator | Manages company Agents, resources and Connections; can enable/disable Operator access and execute host work through that Agent. | Private-content access, impersonation, granting admin/operator and password resets remain separately restricted. |
| admin | Platform and infrastructure administration. | Extra host authority for an ordinary Agent merely because the requester is admin. |
| viewer / guest | Granted read and sharing access. | Mutation or deletion simply because a path or button is visible. |

Current account state, Project membership and write access, Session ownership, Agent state, and execution configuration also apply.

## Private conversations versus work resources

Company operator status alone does not expose private Session contents. Sharing or another valid access basis is required. Platform admins retain separate administration authority; this is not a cryptographic privacy promise against all administrators.

Project files and Agent Connections remain work resources even when a request originates in a private Session. Saving output to Project files applies the file's Project audience. Personal notes and files have a separate boundary. Reading a shared conversation does not authorize sending as its owner or changing execution settings.

## Explicit administrator participation

On supported Project screens, company operators can explicitly join or leave. Participation is separate from ordinary membership. Participation, audit records, and Notification Center entries are persisted together. It does not grant private-content access or another user's send authority. Demotion or disabling ends participation; later promotion does not revive it.

Project participation UI does not restore retired channel screens. Real-time WebSocket/push participation notifications are not guaranteed. Revocation does not undo external effects or guarantee cancellation of already-running work.

## Connection ownership

A Connection identifies an external account and its use scope; a Credential contains its secret authentication material.

- **Agent-dedicated / project:** used for that Agent's work. Confirm that people allowed to request work from the Agent may use this account for that work.
- **Company-shared / workspace:** made available to ordinary Projects across the workspace. Use project scope when only one Agent should receive it.
- **Legacy personal:** not implicitly inherited by new Agent execution. Reconnection or explicit migration requires account-owner consent.

Connecting a personal Google account to a shared Agent makes it an Agent work resource; a private Session does not make that Connection private. Connection management and work request permissions are distinct. Do not paste secrets into chat, Git, or ordinary documents. Disconnecting does not recall sent mail or revert external changes.

## Google Workspace workflow

1. Select the Agent that will do the work.
2. Explicitly connect the intended Google account through Agent Connections.
3. Select a connection ID or one default when multiple accounts exist.
4. Check authentication status and a minimal read-only API.
5. Before sending mail, creating events, or modifying files, verify the account and target.

Selection order: explicit allowed ID, one Agent default, or the only available Connection. Multiple defaults or multiple candidates without a default fail rather than choosing arbitrarily.

Use direct `gws` commands through the supported executor. Replace the example ID with a registered ID:

```bash
GWS_CONNECTION_ID=gws-work gws auth status
GWS_CONNECTION_ID=gws-work gws gmail users getProfile --params '{"userId":"me"}'
```

An execution API exposing `gwsConnectionId` can select the connection explicitly too. Arbitrary wrappers may not trigger automatic credential materialization. Status alone is not proof that the intended provider API succeeds.

### Retired behavior

- `GWS_PROFILE=personal` does not inherit requester authentication.
- Do not run `gws auth login` inside Agent work or use the old host OAuth callback.
- Do not select `users/<id>` bundles by requester or silently substitute the Agent default account.
- Remote/host legacy `finance` aliases require explicit connection selection. Even where a local compatibility alias remains, use connection IDs in new procedures.

## Troubleshooting

| Error | Action |
|---|---|
| `PROJECT_GWS_CREDENTIAL_NOT_AVAILABLE` | Check Agent connection availability and execution materialization. |
| `GWS_CONNECTION_NOT_ALLOWED` | Check the ID and Agent scope; do not retry with an unrelated account. |
| `AMBIGUOUS_GWS_CONNECTION` / `AMBIGUOUS_GWS_DEFAULT` | Select an ID or configure exactly one default. |
| `AGENT_GWS_CONNECTION_REQUIRED` | Remove personal-profile/login requests and connect through Agent Connections. |
| `AGENT_GWS_ACCOUNT_MIGRATION_REQUIRED` | Reconnect or migrate with consent. This may indicate personal/multiple accounts or an unsafe/invalid archive, not just expiration. Do not simply rename personal credential files. |
| `AGENT_GWS_EXPLICIT_CONNECTION_REQUIRED` | Remove the legacy alias and select the intended Agent connection ID. |
| `AGENT_EXECUTION_PLANE_UNAVAILABLE` | Check the Project executor, or the current admin/operator role and active Agent Operator access switch. No extra server allowlist is required. |
| Provider 401 / insufficient permissions | Check configured Connection, per-command materialization, then provider acceptance. |

Check whether a previous external write succeeded before retrying, to avoid duplicate mail or events.

## Platform rollout checklist

- Validate migration 194 on PostgreSQL and coordinate it with code rollout. Missing participation tables can break lists and search.
- Verify that admins and operators can enable and use Agent Operator access. No separate server allowlist or additional approval is required.
- Identify personal/multi-account Google bundles and host-auth-dependent work; migrate only with consent, without copying secrets into documentation.
- Check Projects under protected system paths or platform repositories for operator access failures.
- Verify member work, read-only denial, explicit operator participation, and private Session protection in the actual environment.
- Test streaming load and cross-backend revocation. Authentication caches can introduce delay; immediate global revocation is not guaranteed.
- Verify automations, running work, other engines, and non-bash tools separately. Unit tests are not proof of OS or mount isolation.

## Related documentation

- [Settings, permissions, and Connections](./07-settings-permissions-connections.md)
- [Sessions](./02-sessions.md)
- [Files](./04-files.md)
- [Help index](./index.md)
- [Help maintenance](../README.md)
