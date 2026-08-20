---
title: "Work and Automations"
icon: "⏱️"
order: 5
---

# Work and Automations

Tower separates **work progress** from **scheduled execution**.

- **Work** shows ongoing workstreams, progress, results, decisions, open questions, related conversations, and approval items.
- **Automations** define when a check or AI task runs, what it does, and where it reports.

## Work

Open **Work** from the main menu to review activity across Projects.

A workstream can include:

- current and completed steps;
- recent runs and outcomes;
- decisions and unresolved questions;
- related Sessions;
- backlog or next candidates;
- approvals that require human action.

Work is a reporting and continuity surface. It does not replace the Project Session where the AI performs the work. Open a related Session when you need the full conversation or want to continue the task.

## Progress steps

For longer work, an AI can publish visible progress steps. These steps help you see what is running and where intervention may be needed.

Progress steps are not your private personal to-do list. They describe the AI run. Personal notes and personal tasks use separate user-owned storage.

## Automations

Open **Automations** to review enabled jobs, upcoming runs, current activity, and failures that need attention.

An automation normally defines:

- a name and purpose;
- the Project under which it runs;
- the prompt or check to execute;
- a manual, one-time, daily, weekday, weekly, or interval trigger;
- the destination for results;
- whether AI always runs or only runs when a condition requires it.

## Create an automation with AI

The recommended flow is conversational:

1. Choose **Create automation** or ask for a schedule in a Project Session.
2. Describe what should run, why, when, and where the result should go.
3. Let Tower ask focused questions about missing details.
4. Review the final summary.
5. Confirm before Tower registers the automation.

Example:

> Every weekday at 9:00, summarize yesterday's completed work and today's open risks for this Project. Leave the result in a new run Session.

## Review and change an automation

Use the automation's dedicated conversation to request changes in plain language. Tower can prepare a review draft showing the proposed change, risk, warnings, and impact.

Protected changes are not applied merely because a draft exists. Review the exact proposal before approving it.

## Run history and failures

For each automation, check:

- last and next run;
- current progress;
- completed and failed steps;
- whether the check ran but AI was not needed;
- the Session or result location;
- warnings that need operator or user action.

A failed provider call, missing Connection, runtime failure, and invalid schedule are different failure classes. Use the reported status and next action instead of assuming every failure is an AI model problem.

## Safety

- An automation runs under a defined Project and owner authority.
- Scheduling does not grant new filesystem, tool, or Credential access.
- External writes and destructive actions can still require approval.
- Disable an automation before changing its environment if repeated runs could cause harm.
- Archiving is preferable to destructive deletion when history should remain recoverable.
