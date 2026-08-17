# Room / Channel module

## Responsibility

Owns people-centered channels, membership, messages, invited Agents, and references to project resources.

## Public API

- `room-manager.ts`: channel CRUD, members, messages, persistent Agent Sessions
- `channel-resource-links.ts`: grant/list/revoke Project resources shared with the channel
- `channel-shared-files.ts`: register/list/soft-remove files uploaded directly to the channel
- `channel-agent-memberships.ts`: manage which Primary Agents are discoverable/callable in each channel
- `channel-agent-resolver.ts`: resolve a concrete callable Primary Agent and its identity/runtime defaults
- `channel-authority-resolver.ts`: resolve explicit channel resource grants and fingerprint the audience/share snapshot
- `channel-response-provenance.ts`: validate the completed run before any response is published to the channel
- `room-context.ts`: context summaries for legacy channel AI compatibility

## Before changing this module

- A channel is a people conversation space, not a child of a Project.
- `channel_id`/`short_code` are identity; active user-channel names are normalized and unique for human navigation.
- Existing duplicate names are preserved and distinguished in the sidebar by current invited Agent names plus duplicate count; never auto-merge or auto-rename them.
- Legacy Project origin stays administrator-facing history. If that Project has an explicit active Primary Agent, migration 124 creates a real channel Agent invitation.
- `room_members` is the current channel visibility boundary; channel listing is read-only and never auto-joins users.
- Current rows carry `membership_source`/`invited_by`; `room_membership_events` is append-only history for joins, rejoins, exits, removals, and role changes.
- `channel_resource_links` is the explicit Project share grant: current/future participants and invited Agents receive its discover/read/write capability.
- `channel_shared_files` registers direct uploads under `workspace/uploads/channels/<channel-id>`; active files are read-only Agent inputs and removal revokes future access.
- Legacy `chat_rooms.project_id` is cleared by migration 117 and must not be restored as ownership. Migration 123 preserves its historical meaning separately as `legacy_origin_project_id`.
- Agent invitation controls availability only and never grants Project, file, Credential, tool, or Harness capability.
- A concrete Agent call gets a persistent `channel × Agent Project` Session; its Agent profile snapshot is pinned at creation.
- Only a channel manager who already has Project access may create a resource share; recipients do not need duplicate Project membership.
- Agent invitation grants channel callability, not Agent Project file access. Agent Project supplies identity/Harness only.
- Effective execution intersects Agent Harness, explicit channel resource grants, and Credential/Connector policy.
- No linked readable roots means no filesystem scope. Bash is disabled because cwd-relative commands would create implicit authority.
- Credential-backed connectors, publishing, scheduling, and other tools without an audience-scoped authority model fail closed.
- Response text is not streamed or partially published before the completed run's provenance and freshly resolved authority fingerprint pass validation.

## Related decisions

- `workspace/projects/tower/reports/prd-human-centered-channels.md`
- `workspace/projects/tower/work/agent-harness-channel-considerations.md`
- `workspace/decisions/2026-07-14-people-centered-channel-identity-and-legacy-origin.md`
