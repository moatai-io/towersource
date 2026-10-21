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
  /** Active caller session, used only to label self-matches in results. */
  sessionId?: string | null;
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
  work_limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: 'Max canonical Work Ledger hits. Default 8.' })),
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

function pushSessionGroup(lines: string[], group: SearchResult[], currentSessionId?: string | null) {
  const representative = group[0];
  const archived = representative.archived ? ' · archived' : '';
  const selfMatch = representative.sessionId === currentSessionId ? ' · current session' : '';
  lines.push(`#### ${sessionLink(representative)} (${dateLabel(representative.createdAt)}${archived}${selfMatch})`);
  if (selfMatch) lines.push('- **참고**: 현재 대화의 자기 매칭입니다. 과거 맥락을 찾는 경우 다른 세션 근거를 우선 확인하세요.');

  for (const h of group) {
    if (h.type === 'memory_card') {
      const title = stripHighlights(h.memoryTitle);
      const outcome = stripHighlights(h.memoryOutcome || h.snippet);
      if (title) lines.push(`- **기억**: ${title}`);
      if (outcome) lines.push(`- **기억 요약**: ${outcome.slice(0, 600)}`);
      if (h.memoryNextActions?.length) lines.push(`- **다음 액션**: ${h.memoryNextActions.slice(0, 3).join('; ')}`);
      if (h.memoryCautions?.length) lines.push(`- **주의**: ${h.memoryCautions.slice(0, 2).join('; ')}`);
      continue;
    }
    const snippet = stripHighlights(h.snippet || h.nameSnippet);
    if (snippet) lines.push(`- **${h.type === 'session' ? '세션' : '메시지'} 매칭**: ${snippet.slice(0, 700)}`);
  }
  lines.push('');
}

function groupHitsBySession(hits: SearchResult[]): SearchResult[][] {
  const groups = new Map<string, SearchResult[]>();
  for (const hit of hits) {
    const group = groups.get(hit.sessionId);
    if (group) group.push(hit);
    else groups.set(hit.sessionId, [hit]);
  }
  return [...groups.values()];
}

interface WorkHitGroup { primary: SearchResult; sources: SearchResult[] }

/**
 * Collapse duplicate projections without deleting ledger evidence.
 * Exact run/workstream duplicates merge first. A visible Work Summary may then
 * attach only to the closest TodoWrite in the same session within 30 minutes.
 */
export function groupWorkHits(hits: SearchResult[]): WorkHitGroup[] {
  const groups: WorkHitGroup[] = [];
  for (const hit of hits) {
    const exact = groups.find((group) => group.primary.sessionId === hit.sessionId
      && group.primary.workstreamKey === hit.workstreamKey
      && group.primary.runTitle === hit.runTitle);
    if (exact) {
      exact.sources.push(hit);
      if (exact.primary.workSourceKind === 'work_report' && hit.workSourceKind !== 'work_report') exact.primary = hit;
      continue;
    }
    groups.push({ primary: hit, sources: [hit] });
  }

  const reports = groups.filter((group) => group.primary.workSourceKind === 'work_report');
  for (const report of reports) {
    const reportAt = new Date(report.primary.createdAt).getTime();
    const candidates = groups.filter((group) => group !== report
      && group.primary.sessionId === report.primary.sessionId
      && group.sources.some((source) => source.workSourceType === 'todowrite'))
      .map((group) => ({ group, distance: Math.abs(new Date(group.primary.createdAt).getTime() - reportAt) }))
      .filter(({ distance }) => Number.isFinite(distance) && distance <= 30 * 60_000)
      .sort((a, b) => a.distance - b.distance);
    if (candidates[0]) {
      candidates[0].group.sources.push(...report.sources);
      const index = groups.indexOf(report);
      if (index >= 0) groups.splice(index, 1);
    }
  }
  return groups;
}

function workSourceLabel(hit: SearchResult): string {
  if (hit.workSourceKind === 'work_report') return 'Work Summary';
  if (hit.workSourceType === 'todowrite') return 'TodoWrite';
  return hit.workSourceType || 'Work Ledger';
}

function pushWorkGroup(lines: string[], group: WorkHitGroup) {
  const work = group.primary;
  const title = stripHighlights(work.workstreamTitle || work.runTitle || work.snippet);
  const sources = [...new Set(group.sources.map(workSourceLabel))];
  lines.push(`#### ${title || '업무 기록'} (${dateLabel(work.createdAt)})`);
  lines.push(`- **상태**: ${work.workStatus || 'unknown'} · **출처**: ${sources.join(' + ')}`);
  if (work.runTitle && work.runTitle !== title) lines.push(`- **실행**: ${stripHighlights(work.runTitle)}`);
  const report = group.sources.find((source) => source.workSourceKind === 'work_report');
  const outcome = stripHighlights(report?.workOutcome || work.workOutcome || work.snippet);
  if (outcome) lines.push(`- **결과**: ${outcome.slice(0, 700)}`);
  const todos = group.sources.flatMap((source) => source.workTodos || []);
  if (todos.length) lines.push(`- **작업**: ${todos.slice(0, 5).map((todo) => `[${todo.status}] ${todo.content}`).join('; ')}`);
  const artifacts = [...new Set(group.sources.flatMap((source) => source.workArtifacts || []))];
  if (artifacts.length) lines.push(`- **산출물**: ${artifacts.slice(0, 5).join('; ')}`);
  const backlog = group.sources.flatMap((source) => source.workBacklog || []);
  if (backlog.length) lines.push(`- **남은 일**: ${backlog.slice(0, 3).map((item) => item.title).join('; ')}`);
  if (work.sessionShortCode) lines.push(`- **관련 세션**: ${sessionLink(work)}`);
  if (group.sources.length > 1) lines.push(`- **관련 기록**: ${group.sources.length}건을 대표 업무로 묶음`);
  lines.push('');
}

export function createConversationSearchTool(ctx: ConversationSearchToolContext): ToolDefinition {
  return {
    name: 'conversation_search',
    label: 'Search Tower Conversations',
    description: [
      'Search Tower work and conversation history: canonical Work Ledger records, continuity memory cards, sessions, and raw message evidence.',
      'Use for /search when prior TodoWrite/Work Summary outcomes, exact conversations, session links, or message evidence are needed.',
      'This is closure-scoped to the current Tower user/project permissions; do not ask for API tokens or curl /api/search.',
    ].join(' '),
    parameters: ConversationSearchParams,
    async execute(_toolCallId: string, params: {
      query: string;
      scope?: 'current_project' | 'all_accessible';
      memory_limit?: number;
      work_limit?: number;
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
      const workLimit = Math.min(Math.max(params.work_limit ?? (deep ? 12 : 8), 0), 20);
      const sessionLimit = Math.min(Math.max(params.session_limit ?? (deep ? 12 : 8), 0), 20);
      const messageLimit = Math.min(Math.max(params.message_limit ?? (deep ? 30 : 20), 0), 40);

      try {
        const hits = await search(query, {
          userId: ctx.userId,
          role: ctx.userRole || 'member',
          limit: Math.max(workLimit, memoryLimit, sessionLimit, messageLimit, 1),
          memoryLimit,
          workLimit,
          sessionLimit,
          messageLimit,
          includeArchived: params.include_archived === true,
          deep,
          currentProjectId,
        });

        const warning = hits.partial
          ? `일부 검색에 실패했습니다 (${hits.failedSections?.join(', ')}). 결과가 불완전하므로 검색되지 않았다는 사실을 자료가 없다는 근거로 쓰지 마세요.
`
          : '';
        const workHits = hits.filter((h) => h.type === 'work').slice(0, workLimit);
        const memoryHits = hits.filter((h) => h.type === 'memory_card').slice(0, memoryLimit);
        const sessionHits = hits.filter((h) => h.type === 'session').slice(0, sessionLimit);
        const messageHits = hits.filter((h) => h.type === 'message').slice(0, messageLimit);

        if (hits.length === 0) {
          return { content: [{ type: 'text' as const, text: warning + `No conversation_search results for "${query}" (${scope}). Try shorter Korean nouns or a distinctive session/company name.` }], details: undefined };
        }

        const lines: string[] = warning ? [warning] : [];
        lines.push(`## conversation_search results for "${query}"`);
        const groupedWork = groupWorkHits(workHits);
        lines.push(`scope=${scope}, work=${groupedWork.length}/${workHits.length} raw, memory=${memoryHits.length}, sessions=${sessionHits.length}, messages=${messageHits.length}`);
        lines.push('');
        if (groupedWork.length) {
          lines.push(`### Work — 업무 기록 (${groupedWork.length})`);
          lines.push('');
          for (const group of groupedWork) pushWorkGroup(lines, group);
        }
        const groupedHits = groupHitsBySession([...memoryHits, ...sessionHits, ...messageHits]);
        lines.push(`### Sessions — 세션별 통합 결과 (${groupedHits.length})`);
        lines.push('');
        for (const group of groupedHits) pushSessionGroup(lines, group, ctx.sessionId);

        return { content: [{ type: 'text' as const, text: lines.join('\n').trim() }], details: { hits, partial: !!hits.partial, failedSections: hits.failedSections || [], groupedWorkCount: groupedWork.length, groupedSessionCount: groupedHits.length } };
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
