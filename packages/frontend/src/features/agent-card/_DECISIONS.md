# Agent Card decisions

## Deep module boundary

Agent-card behavior is not a generic chat-rendering concern. It combines backend provenance records, live Agent Session state, tool results, and transcript visibility policy. Keeping this logic in `ChatPanel.tsx` and `MessageBubble.tsx` made debugging brittle, especially around transient `agent_report` rendering.

## Lifecycle owner

The launch card created by `persistent_agent_create` / `persistent_agent_send` owns the visible lifecycle. Compact `agent_report` messages are kept in DB for provenance and parent-AI steering, but hidden from the normal transcript.

## Merge policy

Assistant messages can merge only if neither side is an agent report. Otherwise an `agent_run` block can be appended to the launch assistant message and cause the whole launch card to be interpreted as a report bubble.
