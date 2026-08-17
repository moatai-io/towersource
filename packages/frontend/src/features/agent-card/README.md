# Agent Card

Owns the UI policy/model for Tower subagent and Agent Session cards.

## Responsibility

This feature module keeps agent-specific chat behavior out of generic chat containers:

- classify agent-origin / agent-report messages
- decide which agent provenance records render in the transcript
- decide whether assistant messages may merge
- parse agent-worker tool results into card metadata
- derive stable launch-card title/type/prompt-preview values

## Public API

- `agent-message-policy.ts`
  - `isAgentOriginMessage`
  - `isAgentReportMessage`
  - `isCompactAgentReportMessage`
  - `getVisibleChatMessages`
  - `canMergeAssistantMessages`
  - `mergeConsecutiveAssistant`
- `AgentCards.tsx`
  - `AgentCard`
  - `AgentOriginBubble`
- `agent-card-model.ts`
  - `isAgentTool`
  - `parseAgentWorkerResult`
  - `getAgentCardTitle`
  - `getAgentCardType`
  - `getAgentPromptPreview`

## Invariants

- The original agent launch tool card owns the visible lifecycle.
- Inject-mode `agent_report` records are provenance records and are hidden from the main transcript.
- `agent_report` messages must not merge into assistant launch messages.
- DB transcript and UI transcript are intentionally not identical for compact agent reports.
