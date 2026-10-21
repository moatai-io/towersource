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
- A persisted `modelRecovery` assistant notice must not merge into either the preceding assistant row or the next real answer. `MessageBubble` renders that notice as a compact status chip, so merging would hide the answer behind the chip. See `agent-message-policy.test.ts` and `../../components/chat/MessageBubble.test.tsx`.
- DB transcript and UI transcript are intentionally not identical for compact agent reports.

## Communication route

Launch/send cards show `sending session → receiving session` in both collapsed
and expanded states. Incoming `agentSend` records use their caller provenance;
worker wake responses use the backing session as sender and the viewed chat as
recipient. Parent/child ownership is not used to infer peer-message direction.

Names resolve from the viewer-visible session list, so renames are reflected.
Missing entries retain an available provenance label (or a localized role label)
without creating a new link or fetching private metadata. Newly created/background
sessions become linkable when present in that list; absence is not treated as proof
of denied access. Existing expanded provenance actions remain unchanged, and
navigation continues through the existing server-authorized session entry path.

Route links sit outside expand/collapse buttons, preserve browser modifier-click
behavior and carry full names in titles. Regression coverage:
`AgentCards.communication.test.tsx`, `agent-card-model.test.ts`, and
`../../components/chat/MessageBubble.test.tsx`. Browser/live verification is separate
from these component tests.
