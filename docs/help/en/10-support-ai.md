---
title: "Working with Support AI"
icon: "🤝"
order: 10
---

# Working with support AI

Support AI, or subagents, are colleagues delegated substantial specialist work by the main AI. Each works in a persistent Agent Session with a role and accumulated context. The main AI checks evidence and integrates reports. Delegation does not expand Project or tool permissions.

## Choose parallel or sequential work

| Situation | Approach |
|---|---|
| Independent investigations using agreed source material | Parallel work after inputs and outputs are defined |
| Implementation depends on investigation findings | Accept the findings, decide, implement, then verify |
| Small edit or quick check | Main AI handles it directly |
| Multiple contributors need the same file | Establish ownership and dependencies before editing |

Different roles or filenames do not prove independence. Ask whether each contribution is valid without the other task's result. Keep the agreed inputs stable while they are being investigated, or explicitly coordinate changes.

## Request help

Ask the main AI in ordinary language. Where the `/agent` command is available, it can also route a support AI request. Do not assume that a control panel is exposed in every installation.

> Refresh the Korean and English guides. Have one support AI investigate current features and another investigate retired or changed features, both read-only. Check their evidence before editing the documents yourself, then validate links. Do not deploy or share externally.

The main AI must not assume a worker sees the parent conversation. A useful brief includes:

- Overall goal, roadmap, current stage, milestones, and completion evidence.
- Required expertise, judgment responsibility, and failure signals.
- Canonical documents, existing code and validation paths, and current assumptions.
- Inputs, outputs, prerequisites, edit ownership, and integration location.
- Scope, exclusions, constraints, and conditions for reporting a blocker.

A small mission still needs sufficient context. Extend existing canonical work instead of creating unnecessary management files or duplicate reports.

## Observe and reuse

A support AI retains its Session and context after a bounded assignment. Ask the main AI for the list, state, latest run, or current focus, and send a follow-up to the same colleague when continuity matters. Even one-time work uses a persistent Agent Session; a new worker is not required for every question.

Open the associated Agent Session when you have access to inspect conversation and execution history. Agent Sessions are presented separately from ordinary Chats. Human participation does not automatically remove their Agent identity or existing control relationship.

Reports return to the requesting supervisor and normally resume its work. Successful creation or message delivery does not prove that the assigned work completed or passed verification. Separate Sessions do not imply separate Project files or OS isolation.

## Stop, pause, resume, and archive

- **Stop current execution:** Identify the worker explicitly and verify its runtime state; use Stop in its associated Session where available. Stopping the main Session does not guarantee all workers stop.
- **Pause:** Refuses subsequent follow-up requests. It does not immediately cancel a running task or undo changes.
- **Resume:** Allows a paused colleague to receive follow-up work.
- **Archive:** Archives the worker's registry entry and preserves the backing Session. It does not guarantee immediate cancellation of an active run.

Completed file edits and external actions are not undone by these controls. Delegation cannot bypass approvals for external sending, deployment, deletion, or costly execution.

## Separate conversations

Support AI is managed through role, delegation, and reporting. If you want a separate sidebar conversation that you will continue yourself, explicitly request a new Session. It serves a different purpose from a managed support AI colleague.

## Check the integrated result

Review the final output, evidence, checks actually run, and unresolved uncertainty. Agreement between multiple workers is not proof of correctness. Distinguish unfinished obligations from proposals for new work.

- [Sessions](./02-sessions.md)
- [Work and Automations](./05-work-and-automations.md)
- [Settings and Connections](./07-settings-permissions-connections.md)
