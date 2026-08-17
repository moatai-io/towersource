# Room module decisions

- Channels are people-centered and may exist without any Project resource.
- Channel identity is ID/short code. New active user-channel names are normalized-unique; existing duplicates remain intact and are labeled by current invited Agent names plus duplicate count.
- Historical Project origin is administrator-facing only. An explicit active/ready Primary Agent on that Project is backfilled as a real channel invitation.
- Legacy origin is informational and survives current resource unlink. Duplicate channels are never merged or renamed automatically.
- Project references are many-to-many explicit channel share grants, not channel ownership.
- Direct uploads live in a channel-scoped physical folder with a registry row; they are shared read-only inputs, not copies in each participant's Personal Space.
- Existing `chat_rooms.project_id` values migrate to `channel_resource_links`, then clear to `NULL`.
- Channel visibility comes from current membership. Listing channels never mutates membership or auto-joins privileged/Project users.
- `room_members` stores current provenance; append-only `room_membership_events` records joins, rejoins, self-leaves, removals, and role changes. Unprovable legacy origins remain `legacy_unknown` and are never auto-deleted.
- A channel manager must have Project access to create a link; after that, the link itself grants its declared capability to current/future participants and invited Agents.
- Channel owner/admin explicitly invites Agents; this grants discovery/invocation availability but does not expose the Agent Project's files. Data authority comes only from channel resource links.
- A specific invited Primary Agent mention automatically selects or creates one persistent Session per `channel × Agent Project` and pins that Agent profile/Harness there.
- Legacy `@ai` remains a compatibility alias only; concrete Agent identity is sent as structured `agentProjectId`, not inferred from display-name text.
- Channel filesystem authority is the active explicit resource shares. Duplicate Project membership for every participant is not required; an empty result grants no file scope.
- Shared channel runs deny Bash to prevent the Agent Project cwd from becoming implicit authority. Path-explicit file/data tools remain available within the resolved scope.
- Channel runs return an authority fingerprint plus attempted-tool provenance; publication re-resolves authority and fails closed on mismatch, missing provenance, or a non-audience-safe tool.
- Unvalidated streaming and partial responses are never published to the room. Connector-specific shared authority and semantic secret redaction remain later hardening slices.
