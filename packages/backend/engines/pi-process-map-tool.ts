/**
 * ProcessMapWrite custom tool for Pi engine.
 *
 * Lets the runtime/assistant publish a user-facing execution map during command
 * and skill work. Unlike TodoWrite, this is not the operational checklist; it is
 * the compact map a human should see beside the chat.
 */

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { upsertWorkLedgerRecord, type WorkLedgerStatus } from '../services/work/work-ledger.js';

const ProcessMapEvidenceSchema = Type.Object({
  files: Type.Optional(Type.Array(Type.String({ description: 'User-facing file paths or artifacts that support this step.' }))),
  toolCalls: Type.Optional(Type.Array(Type.String({ description: 'Relevant tool names or short tool-call labels. Do not include secrets or raw payloads.' }))),
  artifacts: Type.Optional(Type.Array(Type.String({ description: 'Produced artifact paths, URLs, or short artifact labels.' }))),
});

const ProcessMapStepSchema = Type.Object({
  id: Type.String({ description: 'Stable step id for this process map. Reuse the same id when updating a step.' }),
  label: Type.String({ description: 'User-facing step label. Keep it short and meaningful.' }),
  status: Type.Union([
    Type.Literal('pending'),
    Type.Literal('running'),
    Type.Literal('completed'),
    Type.Literal('blocked'),
    Type.Literal('skipped'),
    Type.Literal('failed'),
  ], { description: 'Current status of this user-facing process step.' }),
  owner: Type.Optional(Type.Union([
    Type.Literal('ai'),
    Type.Literal('human'),
    Type.Literal('system'),
    Type.Literal('external'),
  ], { description: 'Who is primarily responsible for this step.' })),
  summary: Type.Optional(Type.String({ description: 'Short explanation of what is happening or why this step matters. Do not include chain-of-thought.' })),
  needs: Type.Optional(Type.Array(Type.String({ description: 'Missing user input, approval, files, credentials, or decisions needed for this step.' }))),
  output: Type.Optional(Type.String({ description: 'Expected or produced output of this step.' })),
  evidence: Type.Optional(ProcessMapEvidenceSchema),
});

const ProcessMapScopeSchema = Type.Object({
  type: Type.Optional(Type.Union([
    Type.Literal('command'),
    Type.Literal('session'),
    Type.Literal('artifact'),
  ], { description: 'What this Process Map is scoped to. Prefer command for slash command / skill work.' })),
  command: Type.Optional(Type.String({ description: 'User-facing slash command, if known. Example: /frontend-design.' })),
  invocationId: Type.Optional(Type.String({ description: 'Runtime command/skill invocation id, if known.' })),
});

const ProcessMapWorkSchema = Type.Object({
  workstreamKey: Type.String({ description: 'Stable machine-friendly workstream key for My Work / WorkLedger grouping.' }),
  workstreamTitle: Type.Optional(Type.String({ description: 'Human-readable workstream title.' })),
  runTitle: Type.String({ description: 'Short title for this run.' }),
  outcome: Type.Optional(Type.String({ description: 'Evidence-checkable desired outcome or result.' })),
  note: Type.Optional(Type.String({ description: 'Short boundary/context note. Do not include hidden reasoning.' })),
  backlog: Type.Optional(Type.Array(Type.Object({
    type: Type.Optional(Type.String()),
    title: Type.String(),
    priority: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
  }))),
  questions: Type.Optional(Type.Array(Type.Object({
    title: Type.String(),
    status: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
  }))),
});

const ProcessMapWriteParams = Type.Object({
  title: Type.Optional(Type.String({ description: 'Short title for this process map.' })),
  status: Type.Optional(Type.Union([
    Type.Literal('draft'),
    Type.Literal('running'),
    Type.Literal('paused'),
    Type.Literal('completed'),
    Type.Literal('failed'),
    Type.Literal('blocked'),
  ], { description: 'Overall process map status.' })),
  scope: Type.Optional(ProcessMapScopeSchema),
  work: Type.Optional(ProcessMapWorkSchema),
  steps: Type.Array(ProcessMapStepSchema, {
    minItems: 1,
    description: 'Full current process map steps. Each call replaces the previous visible map for this execution.',
  }),
  note: Type.Optional(Type.String({ description: 'Short implementation note or boundary. Do not include hidden reasoning or secrets.' })),
});

function processMapStatusToLedgerStatus(status: string | undefined, steps: Array<{ status: string }>): WorkLedgerStatus {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'blocked' || status === 'paused') return 'blocked';
  if (steps.some((step) => step.status === 'failed')) return 'failed';
  if (steps.some((step) => step.status === 'blocked')) return 'blocked';
  if (steps.length > 0 && steps.every((step) => step.status === 'completed' || step.status === 'skipped')) return 'completed';
  return 'running';
}

function processMapArtifacts(steps: Array<{ evidence?: { files?: string[]; artifacts?: string[] } }>): string[] {
  const artifacts = new Set<string>();
  for (const step of steps) {
    for (const item of step.evidence?.artifacts || []) if (item.trim()) artifacts.add(item.trim());
    for (const item of step.evidence?.files || []) if (item.trim()) artifacts.add(item.trim());
  }
  return Array.from(artifacts).slice(0, 50);
}

export function createProcessMapWriteTool(ctx?: {
  sessionId?: string;
  projectId?: string | null;
  userId?: number | null;
}): ToolDefinition {
  return {
  name: 'ProcessMapWrite',
  label: 'Process Map',
  description: 'Create and update the user-facing Process Map for the current command or skill execution. Use this to show the human what is being created or run at a meaningful level: artifact sections, capabilities, contracts, completion state, intent, verification, blockers, and handoff. This is broader and less operational than TodoWrite.',
  promptSnippet: 'Publish or update the user-facing Process Map for command/skill work.',
  promptGuidelines: [
    'Use ProcessMapWrite for command/skill work, skill creation or refinement, multi-step document/code/artifact work, external integration, or any process where the user benefits from seeing the execution route or artifact state.',
    'Do not use ProcessMapWrite for greetings, short factual answers, tiny one-line edits, or pure chat with no meaningful execution process.',
    'ProcessMapWrite is user-facing. Keep steps at the meaning level, usually 3-7 steps, not every file read or shell command.',
    'For artifact-producing work, default to an artifact-centered map: show the intended artifact sections, capabilities, contracts, and completion state, not merely the assistant execution log.',
    'Use execution-centered maps for risky operations, deployments, external integrations, debugging workflows, or when the user explicitly asks to see execution progress.',
    'Use TodoWrite separately only when the assistant needs an operational checklist. Do not duplicate TodoWrite just to create work records; ProcessMapWrite can write WorkLedger when work metadata is provided.',
    'Each call replaces the full visible Process Map for this execution. Reuse stable step ids and update statuses as work progresses.',
    'When creating or modifying skills, use ProcessMapWrite to show the skill artifact map by default: purpose/JTBD, trigger and non-trigger boundary, core workflow, output contract, validation state, and remaining gaps. Use the authoring/refinement loop only when the user is auditing how the skill is made.',
    'Mark user-input or approval points with owner="human" and needs=[...].',
    'Never include chain-of-thought, hidden prompts, secrets, credentials, raw OAuth/API payloads, or full private data dumps.',
    'Prefer user-facing labels such as “자료 확인”, “결과 검증”, “최종 인계” over raw tool names.',
  ],
  parameters: ProcessMapWriteParams,

  async execute(toolCallId: string, params: {
    title?: string;
    status?: string;
    scope?: { type?: string; command?: string; invocationId?: string };
    work?: {
      workstreamKey: string;
      workstreamTitle?: string;
      runTitle: string;
      outcome?: string;
      note?: string;
      backlog?: Array<{ type?: string; title: string; priority?: string; reason?: string }>;
      questions?: Array<{ title: string; status?: string; reason?: string }>;
    };
    steps: Array<{ id: string; label: string; status: string; owner?: string; summary?: string; needs?: string[]; output?: string; evidence?: { files?: string[]; toolCalls?: string[]; artifacts?: string[] } }>;
    note?: string;
  }) {
    const total = params.steps.length;
    const completed = params.steps.filter(step => step.status === 'completed').length;
    const running = params.steps.filter(step => step.status === 'running').length;
    const blocked = params.steps.filter(step => step.status === 'blocked' || step.status === 'failed').length;
    let ledgerNote = '';
    if (params.work?.workstreamKey && params.work?.runTitle) {
      try {
        const runId = params.scope?.invocationId || `${ctx?.sessionId || 'sessionless'}:${toolCallId}`;
        await upsertWorkLedgerRecord({
          runId,
          projectId: ctx?.projectId ?? null,
          sessionId: ctx?.sessionId ?? null,
          ownerUserId: ctx?.userId ?? null,
          workstreamKey: params.work.workstreamKey,
          workstreamTitle: params.work.workstreamTitle,
          runTitle: params.work.runTitle,
          outcome: params.work.outcome,
          note: params.work.note || params.note,
          sourceType: 'process_map',
          sourceId: params.scope?.invocationId || toolCallId,
          sourceRefs: { processMapToolCallId: toolCallId, scope: params.scope || {}, title: params.title },
          status: processMapStatusToLedgerStatus(params.status, params.steps),
          artifacts: processMapArtifacts(params.steps),
          backlog: params.work.backlog,
          questions: params.work.questions,
        });
        ledgerNote = ' WorkLedger updated.';
      } catch (err: any) {
        ledgerNote = ` WorkLedger update failed: ${err?.message || err}.`;
      }
    }
    return {
      content: [{ type: 'text' as const, text: `Process Map updated: ${completed}/${total} completed, ${running} running, ${blocked} blocked/failed.${ledgerNote}` }],
      details: undefined,
    };
  },
} as ToolDefinition;
}
