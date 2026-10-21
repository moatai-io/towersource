/**
 * pi-session-transcript-tool.ts — read-only visible transcript access for Pi sessions.
 *
 * Owns: Load persisted user/assistant prose without resuming or messaging the target session.
 * Public API: createSessionTranscriptReadTool(ctx).
 */

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { getMessagesPaginated, type StoredMessage } from '../services/message-store.js';
import { canAccessSession } from '../services/pm/project-access.js';
import { getSessionByKey } from '../services/session/session-manager.js';
import { isShortCode } from '../services/session/short-code.js';

export interface SessionTranscriptReadToolContext {
  userId?: number;
  userRole?: string | null;
  /** Keep transcript tool output within this share of the active model context. */
  modelContextWindow?: number;
}

const TRANSCRIPT_CONTEXT_SHARE = 0.5;
const APPROX_CHARS_PER_TOKEN = 4;
const MIN_TRANSCRIPT_BUDGET_CHARS = 8_000;
const DEFAULT_MODEL_CONTEXT_WINDOW = 200_000;
const DEFAULT_TRANSCRIPT_PAGE_SIZE = 20;
const TRUNCATION_MARKER = '\n\n[… older transcript content omitted to preserve context budget …]\n\n';

type VisibleTranscriptMessage = {
  id: string;
  shortId: string | null;
  role: VisibleRole;
  text: string;
  username: string | null;
  createdAt: string | null;
};

function renderMessage(message: VisibleTranscriptMessage): string {
  return [
    `### ${message.role}${message.username ? ` · ${message.username}` : ''}${message.createdAt ? ` · ${message.createdAt}` : ''}`,
    message.text,
    '',
  ].join('\n');
}

/** Preserve a complete short transcript; for a long transcript retain the newest content within ~50% of context. */
export function fitTranscriptToContext(
  messages: VisibleTranscriptMessage[],
  modelContextWindow = DEFAULT_MODEL_CONTEXT_WINDOW,
): { rendered: string[]; truncated: boolean; omittedMessages: number; budgetChars: number } {
  const budgetChars = Math.max(
    MIN_TRANSCRIPT_BUDGET_CHARS,
    Math.floor(modelContextWindow * TRANSCRIPT_CONTEXT_SHARE * APPROX_CHARS_PER_TOKEN),
  );
  const renderedAll = messages.map(renderMessage);
  const totalChars = renderedAll.reduce((sum, value) => sum + value.length, 0);
  if (totalChars <= budgetChars) {
    return { rendered: renderedAll, truncated: false, omittedMessages: 0, budgetChars };
  }

  const keptNewestFirst: string[] = [];
  let usedChars = TRUNCATION_MARKER.length;
  let omittedMessages = 0;
  for (let index = renderedAll.length - 1; index >= 0; index--) {
    const rendered = renderedAll[index];
    const remaining = budgetChars - usedChars;
    if (rendered.length <= remaining) {
      keptNewestFirst.push(rendered);
      usedChars += rendered.length;
      continue;
    }
    if (keptNewestFirst.length === 0 && remaining > 200) {
      // A single newest message can itself exceed the budget. Keep its tail because
      // continuation state and exact next steps are normally at the end.
      keptNewestFirst.push(`${TRUNCATION_MARKER.trim()}\n${rendered.slice(-(remaining - TRUNCATION_MARKER.length))}`);
    }
    omittedMessages = index + 1;
    break;
  }

  return {
    rendered: [TRUNCATION_MARKER.trim(), ...keptNewestFirst.reverse()],
    truncated: true,
    omittedMessages,
    budgetChars,
  };
}

const SessionTranscriptReadParams = Type.Object({
  session_id: Type.String({ minLength: 1, description: 'Tower session UUID, id, or 8-character short code to read.' }),
  roles: Type.Optional(Type.Array(Type.Union([
    Type.Literal('user'),
    Type.Literal('assistant'),
  ]), {
    minItems: 1,
    maxItems: 2,
    uniqueItems: true,
    description: 'Visible conversation roles to return. Default: both user and assistant.',
  })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: DEFAULT_TRANSCRIPT_PAGE_SIZE, description: `Most recent stored messages to inspect. Default ${DEFAULT_TRANSCRIPT_PAGE_SIZE}.` })),
  before: Type.Optional(Type.String({ minLength: 1, description: 'Message id cursor for loading an older page.' })),
});

type VisibleRole = 'user' | 'assistant';

function visibleText(message: StoredMessage): string {
  let blocks: any = message.content;
  if (typeof blocks === 'string') {
    try { blocks = JSON.parse(blocks); }
    catch { return blocks.trim(); }
  }
  if (!Array.isArray(blocks)) return '';

  return blocks
    .flatMap((block: any) => {
      if (block?.type === 'artifact_markdown' && typeof block.text === 'string') return [block.text.trim()];
      if (block?.type === 'tool_use' && ['create_markdown_artifact', 'update_markdown_artifact'].includes(block.name || block.toolUse?.name)) {
        const body = (block.input || block.toolUse?.input)?.body;
        return typeof body === 'string' ? [body.trim()] : [];
      }
      if (block?.type === 'text' && typeof block.text === 'string') return [block.text.trim()];
      if (block?.type === 'commentary' && block.visibility === 'progress' && typeof block.text === 'string') {
        const text = block.text.trim();
        return text ? [text] : [];
      }
      return [];
    })
    .filter(Boolean)
    .join('\n\n');
}

function isHidden(message: StoredMessage): boolean {
  return Boolean(message.metadata && (message.metadata.hidden || message.metadata.internal));
}

/** Read the human-visible conversation from an accessible Tower session without changing it. */
export function createSessionTranscriptReadTool(ctx: SessionTranscriptReadToolContext): ToolDefinition {
  return {
    name: 'session_transcript_read',
    label: 'Read Session Transcript',
    description: [
      'Read persisted, human-visible user and assistant messages from a Tower session without sending a message or resuming it.',
      'Returns only text displayed as conversation; tool calls, tool results, reasoning, hidden commentary, and hidden system messages are excluded. User-visible commentary is included as assistant text.',
      'Platform admins have a session-read exception. Operators do not have blanket access: operators and other non-admin users must pass the normal Tower session-access check (ownership, explicit internal sharing, or applicable project/channel audience).',
      'An internal session link does not grant access. For Tower /s/<session-id> links, pass the session ID to this tool instead of using WebFetch; distinguish access denied (403), session not found (404), and read failures.',
    ].join(' '),
    parameters: SessionTranscriptReadParams,
    async execute(_toolCallId: string, params: {
      session_id: string;
      roles?: VisibleRole[];
      limit?: number;
      before?: string;
    }) {
      if (!ctx.userId) {
        return {
          content: [{ type: 'text' as const, text: 'session_transcript_read unavailable: no authenticated Tower user is attached to this session.' }],
          details: undefined,
          isError: true,
        };
      }

      const sessionKey = params.session_id.trim();
      const resolvedSession = isShortCode(sessionKey) ? await getSessionByKey(sessionKey, ctx.userId) : null;
      if (isShortCode(sessionKey) && !resolvedSession) {
        return {
          content: [{ type: 'text' as const, text: `session_transcript_read failed: session not found for short code ${sessionKey}` }],
          details: { sessionKey },
          isError: true,
        };
      }
      const sessionId = resolvedSession?.id || sessionKey;
      const access = await canAccessSession(sessionId, ctx.userId, ctx.userRole || 'member');
      if (!access.allowed) {
        return {
          content: [{ type: 'text' as const, text: `session_transcript_read denied (${access.status}): ${access.message}` }],
          details: { sessionId, sessionKey },
          isError: true,
        };
      }

      try {
        const page = await getMessagesPaginated(sessionId, {
          limit: params.limit ?? DEFAULT_TRANSCRIPT_PAGE_SIZE,
          before: params.before,
        });
        const roles = new Set<VisibleRole>(params.roles?.length ? params.roles : ['user', 'assistant']);
        const messages = page.messages.flatMap((message) => {
          if (!roles.has(message.role as VisibleRole) || isHidden(message)) return [];
          const text = visibleText(message);
          if (!text) return [];
          return [{
            id: message.id,
            shortId: message.short_id ?? null,
            role: message.role as VisibleRole,
            text,
            username: message.username ?? null,
            createdAt: message.created_at ?? null,
          }];
        });

        const fitted = fitTranscriptToContext(messages, ctx.modelContextWindow);
        const lines = [
          `## Session transcript: ${sessionId}`,
          `visible_messages=${messages.length}, has_more=${page.hasMore}, oldest_id=${page.oldestId || 'none'}, truncated=${fitted.truncated}, omitted_messages=${fitted.omittedMessages}, budget_chars=${fitted.budgetChars}`,
          fitted.truncated
            ? 'Continuation safety: newest visible conversation was retained; older content was omitted because the full transcript exceeded 50% of the active model context.'
            : 'Continuation safety: the complete visible transcript fits within 50% of the active model context.',
          '',
          ...fitted.rendered,
        ];

        return {
          content: [{ type: 'text' as const, text: lines.join('\n').trim() }],
          details: {
            sessionId,
            sessionKey,
            visibleMessageCount: messages.length,
            returnedMessageCount: Math.max(0, messages.length - fitted.omittedMessages),
            truncated: fitted.truncated,
            omittedMessages: fitted.omittedMessages,
            budgetChars: fitted.budgetChars,
            hasMore: page.hasMore,
            oldestId: page.oldestId,
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `session_transcript_read failed: ${String(err?.message || err || 'unknown error')}` }],
          details: { sessionId, sessionKey },
          isError: true,
        };
      }
    },
  } as ToolDefinition;
}
