/**
 * pi-memory-search-tool.ts — scoped continuity memory search for Pi sessions.
 *
 * Owns: Search prior session continuity cards without replacing broad /search.
 * Public API: createMemorySearchTool(ctx).
 */

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { search } from '../services/workspace/search.js';

export interface MemorySearchToolContext {
  userId?: number;
  userRole?: string | null;
  projectId?: string | null;
}

const MemorySearchParams = Type.Object({
  query: Type.String({
    minLength: 2,
    description: 'Search terms for prior-session continuity summaries, e.g. "runtime box credentials" or "subagent quota".',
  }),
  scope: Type.Optional(Type.Union([
    Type.Literal('current_project'),
    Type.Literal('all_accessible'),
  ], {
    description: 'current_project searches all visible sessions while boosting this project when available. all_accessible searches the same visible scope without that boost. Default: current_project.',
  })),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 10,
    description: 'Maximum continuity memory cards to return. Default 5, max 10.',
  })),
  include_archived: Type.Optional(Type.Boolean({
    description: 'Include archived/history sessions. Default false.',
  })),
});

function stripHighlights(text: string | undefined): string {
  return (text || '')
    .replace(/\u0002/g, '')
    .replace(/\u0003/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function bulletList(items: unknown, max = 3): string {
  if (!Array.isArray(items)) return '';
  const clean = items.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, max);
  return clean.length ? clean.join('; ') : '';
}

export function createMemorySearchTool(ctx: MemorySearchToolContext): ToolDefinition {
  return {
    name: 'memory_search',
    label: 'Search Prior Session Memory',
    description: [
      'Search concise continuity summaries from prior Tower sessions visible to the current user.',
      'Use this when startup memory is too sparse, when a project has multiple active workstreams, or when the user refers to earlier work and the injected memory-context is not enough.',
      'This complements the /search conversation-search skill: prefer memory_search for quick handoff summaries and likely follow-up context; use /search when raw message evidence, exact quotes, session-level results, or broader conversation search is needed.',
      'Returned memory is a hint, not an execution rule. Current user request, AGENTS.md, active SKILL.md, and current files/tools take precedence.',
      'The tool is closure-scoped to the current Tower user/project permissions; do not ask for tokens.',
    ].join(' '),
    parameters: MemorySearchParams,
    async execute(_toolCallId: string, params: {
      query: string;
      scope?: 'current_project' | 'all_accessible';
      limit?: number;
      include_archived?: boolean;
    }) {
      if (!ctx.userId) {
        return {
          content: [{ type: 'text' as const, text: 'memory_search unavailable: no authenticated Tower user is attached to this session.' }],
          details: undefined,
          isError: true,
        };
      }

      const query = (params.query || '').trim();
      if (query.length < 2) {
        return {
          content: [{ type: 'text' as const, text: 'memory_search requires at least 2 characters in query.' }],
          details: undefined,
          isError: true,
        };
      }

      const scope = params.scope || 'current_project';
      const limit = Math.min(Math.max(params.limit ?? 5, 1), 10);
      const currentProjectId = scope === 'current_project' ? (ctx.projectId || null) : null;

      try {
        const hits = await search(query, {
          userId: ctx.userId,
          role: ctx.userRole || 'member',
          limit,
          memoryLimit: limit,
          sessionLimit: 1,
          messageLimit: 1,
          includeArchived: params.include_archived === true,
          currentProjectId,
        });
        const warning = hits.partial
          ? `일부 검색에 실패했습니다 (${hits.failedSections?.join(', ')}). 결과가 불완전하므로 검색되지 않았다는 사실을 자료가 없다는 근거로 쓰지 마세요.
`
          : '';
        const memoryHits = hits.filter((h) => h.type === 'memory_card').slice(0, limit);

        if (memoryHits.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: warning + `No continuity memory cards found for query "${query}" (${scope}). Next step: use /search (conversation-search) for broader sessions/messages, exact wording, or raw evidence.`,
            }],
            details: undefined,
          };
        }

        const lines: string[] = warning ? [warning] : [];
        lines.push(`memory_search results for "${query}" (${scope}, ${memoryHits.length} card${memoryHits.length === 1 ? '' : 's'}):`);
        lines.push('These are prior-session summaries. Treat them as hints; verify against current files/instructions when acting.');
        lines.push('If you need exact wording, raw message evidence, or broader session hits, follow up with /search (conversation-search).');
        for (const [idx, h] of memoryHits.entries()) {
          const title = h.memoryTitle || h.sessionName || 'Untitled session';
          const project = h.projectName ? ` · project=${h.projectName}` : '';
          const archived = h.archived ? ' · archived' : '';
          const date = h.createdAt ? String(h.createdAt).slice(0, 10) : '?';
          lines.push(`\n${idx + 1}. [${date}] ${title}${project}${archived}`);
          lines.push(`   session: ${h.sessionId}${h.sessionShortCode ? ` (${h.sessionShortCode})` : ''}`);
          const outcome = stripHighlights(h.memoryOutcome || h.snippet);
          if (outcome) lines.push(`   summary: ${outcome.slice(0, 500)}`);
          const next = bulletList(h.memoryNextActions, 3);
          if (next) lines.push(`   next: ${next}`);
          const cautions = bulletList(h.memoryCautions, 2);
          if (cautions) lines.push(`   cautions: ${cautions}`);
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }], details: undefined };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `memory_search failed: ${String(err?.message || err || 'unknown error')}` }],
          details: undefined,
          isError: true,
        };
      }
    },
  } as ToolDefinition;
}
