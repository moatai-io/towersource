---
title: "Sessions — Requests and Follow-up Work"
icon: "💬"
order: 2
---

# Sessions — requests and follow-up work

A Session records conversation and execution for analysis, writing, editing, and verification. It uses its Project's instructions and files; it does not automatically know every conversation from other Sessions.

## Create and find Sessions

Choose an appropriate AI teammate or accessible Project and start a Session. Use a specific title such as “Monthly sales analysis” or “Help refresh.” You can ask AI to rename the current Session.

Ask AI to find earlier conversations when you need continuity. Search summaries are clues; verify important decisions against the actual conversation or maintained document.

Visibility depends on ownership, explicit sharing, and applicable Project or audience rules. Sessions are not universally private, and a link alone does not grant access.

## Messages and source material

- Normally **Enter** sends a message and **Shift+Enter** inserts a line break. Input composition and device settings may affect this.
- Attach a file or image, or provide a Project file path.
- Use the `/` menu to discover Skills exposed to this Project.
- When voice input is available, dictate a draft and check it before sending. Microphone permission and a configured voice service are required.

## Change direction during execution

You can send follow-up instructions while AI is working. Delivery depends on the engine and execution state.

- Pi supports mid-run steering. Check the composer's pending and delivered state.
- Other execution paths may queue the message for a later turn.
- A new instruction or Stop does not undo completed commands or external changes.

For an urgent scope reduction, be explicit: “Stop editing files and summarize only the evidence found so far.” After Stop, check what completed and whether any work remains active.

## Questions, approvals, and progress

AI may present a structured question for a consequential choice. Answer through the available options or supply another answer. For deletion, deployment, or external sending, review the exact target and effect before approval.

Long work may show **Work Steps**, which track the AI run. These are separate from your private **My Todo** list. A completed checklist is not proof that an artifact is correct; inspect the result and verification evidence.

## Support AI Sessions

The main AI can delegate substantial independent work to support AI. A support AI has a persistent Agent Session and execution history. Agent Sessions are classified separately from ordinary Chats; direct human participation does not automatically turn one into a Chat.

The main AI receives reports, verifies evidence, and integrates the result. See [Working with support AI](./10-support-ai.md) for delegation, reuse, and stopping work.

## Artifacts and continuity

Check the saved path and right-side Viewer when AI creates a file. Name the existing file and exact section for revisions instead of requesting a new copy unnecessarily.

Sessions and support AI in the same Project can operate on the same files. Separate editing ownership and preserve other contributors' changes.

For a handoff, ask for the goal, completed outputs, file paths, verification, and remaining work. Explicitly ask for a separate sidebar conversation when that is what you need.

## Example

> Compare the Korean and English help with the current code. Verify the findings, update the documents, and check relative links. Preserve other contributors' changes. Do not deploy or commit.

Read completion reports as three distinct things: **what changed, which checks ran, and what remains unverified**.
