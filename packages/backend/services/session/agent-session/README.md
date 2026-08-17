# Agent Session Classification

Owns the boundary between Agent Control Plane backing sessions and normal chat presentation.

## Responsibility

- Decide whether an agent backing session has direct human participation.
- Provide explicit message provenance for direct human chat input.
- Keep UI classification separate from runtime worker control.

## Public API

- `HUMAN_CHAT_SOURCE_TYPE` — canonical `messages.metadata.sourceType` for direct UI chat input.
- `humanTouchedSql(alias)` — SQL predicate for direct human participation, with a legacy fallback.
- `humanChatMetadata()` — metadata to attach when saving a direct human chat message.

## Important rule

Do not infer human participation from `role = 'user'` or `username IS NOT NULL` alone.
Agent-origin spawn/send/wake messages are also stored as user-role messages for engine compatibility.

## Related decisions

- `workspace/decisions/2026-06-14-unify-agent-sessions.md`
- `workspace/decisions/2026-06-14-agent-wake-origin-and-budget-policy.md`
