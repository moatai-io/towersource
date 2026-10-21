# Agent visual teams

## Contract

`visual-teams.ts` owns organization-shared presentation metadata for the AI Team home. A visual team is a label/group for displaying Project-backed agents, **not an authorization team**. It is never used as input to file access, execution, Credentials or Session access decisions.

`routes/agent-visual-teams.ts` is mounted at `/api/agent-visual-teams` in `routes/api.ts`.

- `GET /` returns `{ version, teams: [{ id, name }], assignments: Record<projectId, teamId>, canManage }`.
- `PATCH /` accepts exactly `{ expectedVersion, command }`, where command is `{ kind: 'create', name }` or `{ kind: 'assign', projectId, teamId: string | null }`. Its successful response is the same snapshot shape.
- IDs for new teams are server-generated UUIDs. Null assignment removes a Project from its current visual group. Team names are trimmed, 1–80 characters, have no control characters and must be case-insensitively unique. There can be at most 200 teams and 10,000 assignments.
- The current account is re-read from `users`; it must be enabled, approved/active and have a supported staff/guest role. Only a current administrator can mutate this shared metadata. Cached JWT roles do not grant management authority.
- Every snapshot filters **assignments** using the canonical `getAccessibleProjectIds` helper in `pm/project-membership-manager.ts`. Current Project discovery is membership-only, including administrators and operators; ownership and role alone do not grant content access. Archived/retired Projects are not returned.
- Administrators see all visual **team labels**, including empty groups, because they manage organization-wide presentation settings. This does not expose the IDs of inaccessible Projects in their returned assignments. Other accounts see only labels referenced by their accessible assignments; `canManage` is false.
- An administrator can assign any valid active Project as an organization metadata operation; this never adds membership. Such an assignment does not cause that Project to appear in the administrator's Project list or board unless it is independently accessible. This management scope is distinct from content access.
- Assignment targets must exist and be active/unarchived. Missing Projects or visual teams return 404. Invalid commands, unknown fields, excessive lengths and capacity limits return 400. Inactive accounts or non-admin mutations return 403. Stale `expectedVersion` returns 409 and does not write; callers should reload the snapshot before retrying.
- Unexpected database/path errors return generic messages rather than raw SQL or filesystem details.

## Storage and concurrency

The existing `app_settings` JSONB table stores one installation-wide key, `agent_visual_teams_v1`, containing `{ version, teams, assignments }`. No new schema/migration is required. Initial absence returns version 0 with empty metadata without a read-time write.

Mutations acquire a transaction-scoped PostgreSQL advisory lock on the setting key **before** reading the state, so concurrent first writes are serialized as well. A version mismatch aborts the transaction. The row is upserted with `updated_by` and `updated_at`; the version increments once per successful command. The actor and assignment target are share-locked to prevent their state changing during validation/persistence. Invalid stored JSON/reference data fails closed instead of overwriting it.

The service reads existing membership through the canonical helper but never accesses authority-team tables, modifies users/Projects/memberships/grants/Sessions/Credentials, or changes Project files. Existing permission-team routes and management flags are independent and unchanged.

## Evidence and boundaries

- `visual-teams.test.ts`: actor checks, visibility filtering, command bounds, UUID creation, version conflict, assignment changes, capacity and authority-write exclusions.
- `../../routes/agent-visual-teams.test.ts`: HTTP authentication, strict payloads, actor closure, snapshot responses and safe status/error handling.
- `visual-teams.postgres.test.ts`: explicit opt-in disposable PostgreSQL fixture, real JSONB persistence, concurrent CAS, canonical membership-only discovery, invalid targets and unchanged authority tables.

Run:

```sh
npx vitest run packages/backend/services/agent-workspaces/visual-teams.test.ts packages/backend/routes/agent-visual-teams.test.ts
VISUAL_TEAMS_PG_TEST=1 npx vitest run packages/backend/services/agent-workspaces/visual-teams.postgres.test.ts
npx tsc -b tsconfig.backend.json --pretty false
```

The PostgreSQL fixture uses an isolated `work/visual-teams-pg-*` cluster and synthetic schema, not the application's database, credentials or migrations. Test evidence is local only: it does not assert deployment, browser acceptance or production verification.
