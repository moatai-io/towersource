# Decisions

## Human participation is explicit provenance, not role inference

Agent-origin messages may be persisted as `role = 'user'` and may carry a `username` so engines can resume and UIs can show provenance. Therefore session classification must not treat user-role rows as human participation by themselves.

Direct UI chat input is marked with `messages.metadata.sourceType = 'human_chat'`. Existing pre-provenance messages are supported only through a legacy fallback: user role + username + empty metadata. That fallback should stay local to this module and not spread into call sites.

## UI classification does not control worker lifecycle

When a human participates in an Agent Session, the backing worker remains controllable by the parent agent. The only default behavior change is sidebar presentation: pure agent sessions are hidden from Chats and shown under Agents; human-touched agent sessions appear as Chats.
