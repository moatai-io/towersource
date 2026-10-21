# Agent Sessions

Owns frontend presentation rules for Agent Control Plane backing sessions.

## Responsibility

- Decide whether a session should be presented as a pure Agent Session in the sidebar.
- Keep UI classification separate from runtime worker control.

## Public API

- `isPureAgentSession(session)` — true when a session belongs in the Agents filter and should be hidden from default Chats.

## Important rule

A human-touched Agent Session is still an agent worker backing session at runtime. The parent worker may continue to control it. Direct human participation does not reclassify it as a Chat. `label === 'agent'` or worker metadata preserves its Agent identity in both filters and row presentation.

## Backend counterpart

- `packages/backend/services/session/agent-session/`

## Row presentation and verification

- `AgentSessionBadge.tsx` uses `isPureAgentSession` to render a compact `agent` badge before the title in `components/sessions/SessionItem.tsx`. Normal chats and task runs without worker identity do not receive this badge.
- `AgentSessionBadge.test.tsx` renders label-only, metadata-only, human-participated and ordinary session fixtures. `SessionItem.presentation.source.test.ts` guards the row integration. These are local regression checks, not live browser verification.
