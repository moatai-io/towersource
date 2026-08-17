/**
 * pi-conversation-search-tool.ts — scoped broad conversation search for Pi sessions.
 *
 * Owns: Search prior Tower sessions/messages without raw API tokens.
 * Public API: createConversationSearchTool(ctx).
 */

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { config } from '../config.js';
import { search, type SearchResult } from '../services/workspace/search.js';

export interface ConversationSearchToolContext {
  userId?: number;
  userRole?: string | null;
  projectId?: string | null;
}

const ConversationSearchParams = Type.Object({
  query: Type.String({
    minLength: 2,
    description: 'Search terms for Tower conversation history, e.g. "schedule management" or "meeting assistant".',
  }),
  scope: Type.Optional(Type.Union([
    Type.Literal('current_project'),
    Type.Literal('all_accessible'),
  ], {
    description: 'current_project boosts the current project when available. all_accessible searches all visible sessions. Default: current_project.',
  })),
  memory_limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: 'Max memory-card hits. Default 8.' })),
  session_limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: 'Max session hits. Default 8.' })),
  message_limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 40, description: 'Max message hits. Default 20.' })),
  include_archived: Type.Optional(Type.Boolean({ description: 'Include archived/history sessions. Default false.' })),
  deep: Type.Optional(Type.Boolean({ description: 'Use larger search defaults for research. Default false.' })),
});

function stripHighlights(text: string | undefined): string {
  return (text || '')
    .replace(/\u0002/g, '')
    .replace(/\u0003/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function dateLabel(value: string | undefined): string {
  return value ? String(value).slice(0, 10) : '?';
}

function sessionLink(h: SearchResult): string {
  const key = h.sessionShortCode || h.sessionId;
  const project = h.projectName || '(no project)';
  const base = config.publicUrl || config.sharePublicUrl || 'https://tower.tower.example.com';
  return `[${project} · ${h.sessionName}](${base}/s/${key})`;
}

function pushHit(lines: string[], h: SearchResult) {
  const archived = h.archived ? ' · archived' : '';
  lines.push(`#### ${sessionLink(h)} (${dateLabel(h.createdAt)}${archived})`);
  if (h.type === 'memory_card') {
    const title = h.memoryTitle ? `**기억**: ${stripHighlights(h.memoryTitle)}` : '';
    const outcome = stripHighlights(h.memoryOutcome || h.snippet);
    if (title) lines.push(`- ${title}`);
    if (outcome) lines.push(`- **요약**: ${outcome.slice(0, 600)}`);
    if (h.memoryNextActions?.length) lines.push(`- **다음 액션**: ${h.memoryNextActions.slice(0, 3).join('; ')}`);
    if (h.memoryCautions?.length) lines.push(`- **주의**: ${h.memoryCautions.slice(0, 2).join('; ')}`);
  } else {
    const snippet = stripHighlights(h.snippet || h.nameSnippet);
    if (snippet) lines.push(`- **매칭**: ${snippet.slice(0, 700)}`);
  }
  lines.push('');
}

export function createConversationSearchTool(ctx: ConversationSearchToolContext): ToolDefinition {
  return {
    name: 'conversation_search',
    label: 'Search Tower Conversations',
    description: [
      'Search Tower conversation history: continuity memory cards, sessions, and raw message evidence.',
      'Use for /search when exact prior conversations, session links, or message evidence are needed.',
      'This is closure-scoped to the current Tower user/project permissions; do not ask for API tokens or curl /api/search.',
    ].join(' '),
    parameters: ConversationSearchParams,
    async execute(_toolCallId: string, params: {
      query: string;
      scope?: 'current_project' | 'all_accessible';
      memory_limit?: number;
      session_limit?: number;
      message_limit?: number;
      include_archived?: boolean;
      deep?: boolean;
    }) {
      if (!ctx.userId) {
        return {
          content: [{ type: 'text' as const, text: 'conversation_search unavailable: no authenticated Tower user is attached to this session.' }],
          details: undefined,
          isError: true,
        };
      }

      const query = (params.query || '').trim();
      if (query.length < 2) {
        return {
          content: [{ type: 'text' as const, text: 'conversation_search requires at least 2 characters in query.' }],
          details: undefined,
          isError: true,
        };
      }

      const scope = params.scope || 'current_project';
      const currentProjectId = scope === 'current_project' ? (ctx.projectId || null) : null;
      const deep = params.deep === true;
      const memoryLimit = Math.min(Math.max(params.memory_limit ?? (deep ? 12 : 8), 0), 20);
      const sessionLimit = Math.min(Math.max(params.session_limit ?? (deep ? 12 : 8), 0), 20);
      const messageLimit = Math.min(Math.max(params.message_limit ?? (deep ? 30 : 20), 0), 40);

      try {
        const hits = await search(query, {
          userId: ctx.userId,
          role: ctx.userRole || 'member',
          limit: Math.max(memoryLimit, sessionLimit, messageLimit, 1),
          memoryLimit,
          sessionLimit,
          messageLimit,
          includeArchived: params.include_archived === true,
          deep,
          currentProjectId,
        });

        const memoryHits = hits.filter((h) => h.type === 'memory_card').slice(0, memoryLimit);
        const sessionHits = hits.filter((h) => h.type === 'session').slice(0, sessionLimit);
        const messageHits = hits.filter((h) => h.type === 'message').slice(0, messageLimit);

        if (hits.length === 0) {
          return { content: [{ type: 'text' as const, text: `No conversation_search results for "${query}" (${scope}). Try shorter Korean nouns or a distinctive session/company name.` }], details: undefined };
        }

        const lines: string[] = [];
        lines.push(`## conversation_search results for "${query}"`);
        lines.push(`scope=${scope}, memory=${memoryHits.length}, sessions=${sessionHits.length}, messages=${messageHits.length}`);
        lines.push('');
        if (memoryHits.length) {
          lines.push('### Memory cards — 이어받을 만한 정제 기억');
          lines.push('');
          for (const h of memoryHits) pushHit(lines, h);
        }
        if (sessionHits.length) {
          lines.push('### Sessions — 세션 이름/요약 매칭');
          lines.push('');
          for (const h of sessionHits) pushHit(lines, h);
        }
        if (messageHits.length) {
          lines.push('### Messages — 원문 근거');
          lines.push('');
          for (const h of messageHits) pushHit(lines, h);
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n').trim() }], details: { hits } };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `conversation_search failed: ${String(err?.message || err || 'unknown error')}` }],
          details: undefined,
          isError: true,
        };
      }
    },
  } as ToolDefinition;
}
