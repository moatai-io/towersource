/**
 * TodoWrite custom tool for Pi engine.
 *
 * Mirrors Claude SDK's built-in TodoWrite tool so Pi agents can also
 * track task progress with inline checklists in the Tower UI.
 *
 * TodoWrite is primarily the live progress checklist shown in chat.
 * It can still carry optional `work` metadata for explicit long-running or
 * high-accountability work, but assistants should not add workstream metadata
 * just to manufacture Recent Work records. Durable work memory should come
 * from final `Work Summary:` blocks and user-facing artifacts, with TodoWrite
 * metadata as an exception. When session context and work metadata are present,
 * the tool upserts a Work Ledger record; MessageBubble independently renders
 * the checklist from the persisted tool_use input.
 */

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { upsertWorkLedgerRecord, type WorkLedgerStatus } from '../services/work/work-ledger.js';

const TodoItemSchema = Type.Object({
  content: Type.String({ description: 'Task description in imperative form (e.g., "Run tests")' }),
  status: Type.Union([
    Type.Literal('pending'),
    Type.Literal('in_progress'),
    Type.Literal('completed'),
  ], { description: 'Current status of this task' }),
  activeForm: Type.String({ description: 'Present continuous form shown during execution (e.g., "Running tests")' }),
});

const TodoWorkSchema = Type.Object({
  mode: Type.Union([
    Type.Literal('new'),
    Type.Literal('continue'),
  ], { description: 'Whether this TodoWrite starts a new delegated work run or continues an existing one.' }),
  workstreamKey: Type.Optional(Type.String({ description: 'Stable machine-friendly key for the ongoing workstream. Reuse it across sessions/turns so My Work can group related runs.' })),
  workstreamTitle: Type.Optional(Type.String({ description: 'Human-readable title for the ongoing workstream/challenge shown in My Work.' })),
  runTitle: Type.Optional(Type.String({ description: 'Short human-readable title for this specific run/turn.' })),
  outcome: Type.Optional(Type.String({ description: 'Evidence-checkable success criterion or desired outcome for the workstream/run.' })),
  epic: Type.Optional(Type.String({ description: 'Deprecated v2 alias for workstreamKey/workstreamTitle. Keep for backward compatibility only.' })),
  title: Type.Optional(Type.String({ description: 'Deprecated v2 run title. Prefer runTitle for new calls.' })),
  goal: Type.Optional(Type.String({ description: 'Deprecated v2 outcome/goal. Prefer outcome for new calls.' })),
  note: Type.Optional(Type.String({ description: 'Short work note: assumptions, boundary, intended method/tooling, or context that helps future readers understand this work. Do not include long reasoning traces.' })),
  description: Type.Optional(Type.String({ description: 'Deprecated alias for note. Prefer note for new calls.' })),
  continuationOf: Type.Optional(Type.String({ description: 'Existing workstream/run id/title/key when mode="continue". Omit for new work.' })),
});

const TodoBacklogItemSchema = Type.Object({
  type: Type.Optional(Type.Union([
    Type.Literal('task'),
    Type.Literal('design'),
    Type.Literal('research'),
    Type.Literal('test'),
    Type.Literal('docs'),
  ], { description: 'Kind of follow-up item. Use task for executable work and design for open product/architecture shaping.' })),
  title: Type.String({ description: 'Short title for a future work candidate. Do not duplicate active todos here.' }),
  priority: Type.Optional(Type.String({ description: 'Optional priority label such as P0, P1, P2, later.' })),
  reason: Type.Optional(Type.String({ description: 'Why this follow-up matters or what triggered it.' })),
});

const TodoQuestionSchema = Type.Object({
  title: Type.String({ description: 'Open product, design, policy, or architecture question discovered during the run.' }),
  status: Type.Optional(Type.Union([
    Type.Literal('open'),
    Type.Literal('answered'),
    Type.Literal('deferred'),
  ], { description: 'Question status. Default to open for new unresolved questions.' })),
  reason: Type.Optional(Type.String({ description: 'Short context explaining why the question matters.' })),
});

const TodoWriteParams = Type.Object({
  work: Type.Optional(TodoWorkSchema),
  todos: Type.Array(TodoItemSchema, {
    description: 'The full updated todo list for the current run. Each call replaces the entire list.',
  }),
  backlog: Type.Optional(Type.Array(TodoBacklogItemSchema, {
    description: 'Future work candidates discovered during this run. Do not include work being executed in the current todos.',
  })),
  questions: Type.Optional(Type.Array(TodoQuestionSchema, {
    description: 'Open questions discovered during this run. Use for decisions that are not executable todos yet.',
  })),
});

function todoStatusToLedgerStatus(todos: Array<{ status: string }>): WorkLedgerStatus {
  return todos.length > 0 && todos.every((todo) => todo.status === 'completed') ? 'completed' : 'running';
}

/** Create a TodoWrite tool whose repeated calls update one canonical run record. */
export function createTodoWriteTool(ctx?: {
  sessionId?: string;
  projectId?: string | null;
  userId?: number | null;
}): ToolDefinition {
  let ledgerRunId: string | null = null;
  let ledgerSourceId: string | null = null;

  return {
  name: 'TodoWrite',
  label: '진행 단계',
  description: 'Create and manage the AI run\'s “진행 단계 · Work Steps” for live progress visibility. This is not the user\'s private “내 할 일 · My Todo” checklist. Use it when the user benefits from seeing multi-step execution state during a longer, risky, or externally visible task. Each call sends the full updated list (not a diff). Work metadata is optional and should be reserved for explicit long-lived/high-accountability work; ordinary Recent Work memory should come from final Work Summary blocks and artifacts. The UI renders this as an interactive checklist with a progress bar.',
  promptSnippet: 'Track the AI run\'s 진행 단계 (Work Steps) with a visual checklist when live progress visibility is useful. Do not use TodoWrite as the default Recent Work logger, and never use it for the user\'s private 내 할 일 (My Todo).',
  promptGuidelines: [
    'TodoWrite means the AI run\'s “진행 단계 · Work Steps”; “내 할 일 · My Todo” belongs to personal_note_append.',
    'Use TodoWrite only when live progress visibility materially helps the user: longer multi-step execution, risky/operational work, external actions, deployment preparation, or a task where the user may need to interrupt or monitor progress.',
    'Do NOT use TodoWrite merely because a task has a few internal steps, or just to create a Recent Work record. For ordinary completed work, add a Work Summary: block in the final answer instead, regardless of the conversation language.',
    'Do NOT use TodoWrite for greetings, quick factual answers, tiny wording edits, short analysis, simple document edits, or purely informational responses.',
    'Work metadata is optional. Include work metadata only when this run truly needs a durable WorkLedger row during execution, such as a long-running operation, explicit ongoing workstream, protected action, or cross-session handoff.',
    'When work metadata is justified, prefer v3 fields: workstreamKey, workstreamTitle, runTitle, outcome, and note. Existing epic/title/goal are backward-compatible v2 aliases only.',
    'Do not invent or overfit workstreamKey/workstreamTitle for routine turns. If unsure, omit work metadata and use Work Summary: in the final answer for searchable work memory.',
    'Use work.outcome for the evidence-checkable success criterion. Use work.note for assumptions, boundaries, intended method/tooling, or context. Keep note to 1-2 short sentences and do not include long reasoning traces.',
    'Use top-level backlog for future work candidates discovered during the run. Use top-level questions for unresolved design/product/policy questions. Do not mix backlog/questions into the current todos unless you are executing them now.',
    'If work metadata is justified and the request continues a known prior workstream, set work.mode="continue" and continuationOf to the known id/title/key; otherwise use work.mode="new".',
    'Each call must include the FULL current-run todo list (all items), not just changed ones.',
    'Keep exactly ONE task as in_progress at a time.',
    'Mark tasks completed IMMEDIATELY after finishing each one.',
    'If you used TodoWrite during a turn, call TodoWrite one final time BEFORE the final answer with every finished item marked completed so the live progress card closes cleanly.',
    'Avoid a final todo that only says “report results” when possible; use a completion step that can be marked done before the final answer, such as “Verify and summarize impact”. Put durable memory in the final Work Summary: block, not in artificial checklist items.',
    'If any item genuinely remains unfinished, leave it pending/in_progress and mention the remaining work in the final answer.',
    'Write todo content, activeForm, and any justified work metadata in the user/session language by default. In Korean sessions, use natural Korean work phrases. Keep code identifiers, file paths, commands, and API names as-is.',
    'Make each todo specific enough to help the user understand current progress: name the target, artifact, decision, or verification when it matters.',
    'Do not write vague todos like "Update code", "Run tests", or "Summarize"; prefer concrete lines like "Update ToolUseCard running label", "Run ToolUseCard and MessageBubble tests", or "Summarize changed files and verification".',
    'For Korean sessions, prefer concise task lines such as "ToolUseCard의 running 문구를 한글 업무 표현으로 바꾸기" and activeForm like "ToolUseCard의 running 문구를 한글 업무 표현으로 바꾸는 중".',
    'Keep each todo one concise line. Prefer 3–7 meaningful work steps over tiny tool-level actions.',
    'Do not mirror raw tool calls as todos. Todos should describe user-facing work steps, not "grep", "bash", "read file", or other tool invocations.',
    'Task content should be imperative/action-oriented; activeForm should describe the same task in progress.',
  ],
  parameters: TodoWriteParams,

  async execute(toolCallId: string, params: {
    work?: {
      mode: 'new' | 'continue';
      workstreamKey?: string;
      workstreamTitle?: string;
      runTitle?: string;
      outcome?: string;
      epic?: string;
      title?: string;
      goal?: string;
      note?: string;
      description?: string;
      continuationOf?: string;
    };
    todos: Array<{ content: string; status: string; activeForm: string }>;
    backlog?: Array<{ type?: string; title: string; priority?: string; reason?: string }>;
    questions?: Array<{ title: string; status?: string; reason?: string }>;
  }) {
    const total = params.todos.length;
    const completed = params.todos.filter(t => t.status === 'completed').length;
    const inProgress = params.todos.filter(t => t.status === 'in_progress').length;
    let ledgerNote = '';

    const workstreamKey = params.work?.workstreamKey || params.work?.epic;
    const runTitle = params.work?.runTitle || params.work?.title;
    if (ctx?.sessionId && workstreamKey && runTitle) {
      ledgerRunId ||= `${ctx.sessionId}:todowrite:${toolCallId}`;
      ledgerSourceId ||= toolCallId;
      try {
        await upsertWorkLedgerRecord({
          runId: ledgerRunId,
          projectId: ctx.projectId ?? null,
          sessionId: ctx.sessionId,
          ownerUserId: ctx.userId ?? null,
          workstreamKey,
          workstreamTitle: params.work?.workstreamTitle || params.work?.epic,
          runTitle,
          outcome: params.work?.outcome || params.work?.goal,
          note: params.work?.note || params.work?.description,
          sourceType: 'todowrite',
          sourceId: ledgerSourceId,
          sourceRefs: {
            firstTodoWriteToolCallId: ledgerSourceId,
            latestTodoWriteToolCallId: toolCallId,
            mode: params.work?.mode,
            continuationOf: params.work?.continuationOf,
          },
          status: todoStatusToLedgerStatus(params.todos),
          todos: params.todos,
          backlog: params.backlog,
          questions: params.questions,
        });
        ledgerNote = ' WorkLedger updated.';
      } catch (err: any) {
        console.warn('[TodoWrite] WorkLedger update failed:', err?.message || err);
        ledgerNote = ` WorkLedger update failed: ${err?.message || err}.`;
      }
    }

    return {
      content: [{ type: 'text' as const, text: `Todo list updated: ${completed}/${total} completed, ${inProgress} in progress.${ledgerNote}` }],
      details: undefined,
    };
  },
} as ToolDefinition;
}

/** Context-free compatibility export for tests and external consumers. */
export const todoWriteTool: ToolDefinition = createTodoWriteTool();
