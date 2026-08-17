/**
 * Owns: personal_note_append, the first-party Pi action for user-owned inbox notes.
 * Public API: createPersonalNoteAppendTool(ctx).
 */
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { appendToPersonalInbox } from '../services/personal-space/personal-space-store.js';
import { createPersonalTodo } from '../services/personal-space/personal-todo-store.js';

export interface PersonalNoteToolContext {
  userId?: number;
  sessionId: string;
}

const PersonalNoteAppendParams = Type.Object({
  text: Type.String({
    minLength: 1,
    maxLength: 4000,
    description: 'Text to append to the current user\'s private notes/inbox.md. Use the user\'s wording without adding unsupported details.',
  }),
  checklist: Type.Optional(Type.Boolean({
    description: 'Write as an unchecked Markdown checklist item. Default false for a normal bullet.',
  })),
});

function result(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError, details: undefined };
}

/** Create a user-closure-scoped personal inbox append tool. */
export function createPersonalNoteAppendTool(ctx: PersonalNoteToolContext): ToolDefinition {
  return {
    name: 'personal_note_append',
    label: '개인 노트에 기록',
    description: [
      'Append one bullet or unchecked checklist item to the authenticated user\'s private Personal Space inbox.md.',
      'Use when the user explicitly says “노트에 기록”, “개인 메모에 남겨”, or “내 할 일에 추가”.',
      'This is not a project file and is never mounted into Project Runtime Box.',
      'After a successful append, Tower opens personal://notes/inbox.md in the Viewer Pane so the user can verify or edit it.',
    ].join(' '),
    promptSnippet: 'When the user explicitly asks to record something in their personal note or personal checklist, use personal_note_append instead of editing a project file. Tower will open the personal inbox in Viewer after success.',
    promptGuidelines: [
      'Use checklist=true for explicit “내 할 일”, personal todo, or my todo requests; otherwise use a normal bullet.',
      'Do not call this tool for vague future-work discussion unless the user asks to record it.',
      'Keep the recorded text concise and faithful to the user request.',
      'Treat “내 할 일 · My Todo” as the user-owned private checklist. Do not confuse it with TodoWrite, which is the AI run\'s “진행 단계 · Work Steps”.',
      'Do not create a project task, TodoWrite run, schedule, or GitHub issue when the user specifically asks for 내 할 일.',
      'Do not call present_file after this tool: personal:// is not a project path, and a successful result opens the Personal Space inbox automatically.',
    ],
    parameters: PersonalNoteAppendParams,
    async execute(_toolCallId: string, params: { text: string; checklist?: boolean }) {
      if (!ctx.userId) return result('personal_note_append unavailable: authenticated user context is missing.', true);
      try {
        if (params.checklist === true) {
          const todo = await createPersonalTodo(ctx.userId, params.text, ctx.sessionId);
          return result(JSON.stringify({
            ok: true,
            action: 'personal_todo_add',
            todo,
            uri: 'personal://todos',
            checklist: true,
            focus: true,
            split: 'right',
            message: '내 할 일에 추가하고 Viewer에서 열었습니다.',
          }, null, 2));
        }
        const note = await appendToPersonalInbox(ctx.userId, params.text, false);
        return result(JSON.stringify({
          ok: true,
          action: 'personal_note_append',
          uri: note.uri,
          name: note.name,
          checklist: false,
          version: note.version,
          focus: true,
          split: 'right',
          message: '개인 노트에 기록하고 Viewer에서 열었습니다.',
        }, null, 2));
      } catch (error) {
        return result(`personal_note_append failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  } as ToolDefinition;
}
