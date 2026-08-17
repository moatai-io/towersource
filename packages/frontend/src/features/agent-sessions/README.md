# Agent Sessions

Owns frontend presentation rules for Agent Control Plane backing sessions.

## Responsibility

- Decide whether a session should be presented as a pure Agent Session in the sidebar.
- Keep UI classification separate from runtime worker control.

## Public API

- `isPureAgentSession(session)` — true when a session belongs in the Agents filter and should be hidden from default Chats.

## Important rule

A human-touched Agent Session is still an agent worker backing session at runtime. The parent worker may continue to control it. The UI simply presents it as a chat once a human has directly participated.

## Backend counterpart

- `packages/backend/services/session/agent-session/`
