/**
 * memory-context.ts
 *
 * Owns: Pi engine startup memory inject.
 * Public API: buildMemoryContext(opts) → string | null
 *
 * Tower is Pi-first now. The old Claude CLI `~/.claude/memory.db` hook path is
 * intentionally not the default source anymore: it has no user_id/project_id,
 * goes stale for Pi sessions, and can mix users inside shared projects.
 *
 * Source of truth: PostgreSQL Tower tables, scoped to the same user + same
 * project as the current session. Team/project-shared memory can be added later
 * as a separate explicit block; this block is personal continuity only.
 *
 * Related decisions:
 *   - workspace/decisions/2026-05-20-session-file-edits-pg-unification.md
 *   - workspace/decisions/2026-05-17-pi-memory-context-inject.md (superseded in source, kept for format history)
 */

import { basename } from 'path';
import { query } from '../../db/pg-repo.js';
import { getMemoryCardsForContext, type SessionMemoryCard } from './session-memory-card.js';

function truncate(str: string | null | undefined, maxLen = 200): string {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '?';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value);
  const isoDate = s.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  return isoDate || s.slice(0, 10);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export interface BuildMemoryContextOpts {
  /** Current Tower session id. Excluded so we only inject prior context. */
  sessionId: string;
  /** Current Tower user id. Required for personal memory isolation. */
  userId?: number | null;
  /** Current Tower project id. Required for project-scoped memory isolation. */
  projectId?: string | null;
  /** Current cwd, only used as a cautious fallback when projectId is absent. */
  cwd?: string | null;
  /** Human/project label for the XML attribute. */
  projectLabel?: string | null;
}

interface RecentSessionRow {
  id: string;
  name: string;
  summary: string | null;
  files_edited: string | null;
  updated_at: string;
  turn_count: number | null;
}

interface RecentFileRow {
  session_id: string;
  session_name: string;
  file_path: string;
  tool_name: string | null;
  touched_at: string;
}

function listItems(items: string[] | null | undefined, max = 3): string {
  const arr = Array.isArray(items) ? items.filter(Boolean).slice(0, max) : [];
  return arr.length > 0 ? arr.join(', ') : '';
}

function appendCardLines(lines: string[], cards: SessionMemoryCard[]): void {
  lines.push('## 최근 작업 힌트');
  for (const c of cards.slice(0, 3)) {
    const title = c.title || '이전 세션';
    const outcome = c.outcome ? ` — ${truncate(c.outcome, 120)}` : '';
    lines.push(`- [${formatDate(c.memory_date || c.updated_at)}] ${truncate(title, 90)}${outcome}`);
  }
  lines.push('자세한 과거 맥락이 필요하면 memory_search를 사용한다.');
}

function buildScopeWhere(opts: BuildMemoryContextOpts, startParamIndex: number): { sql: string; params: any[] } | null {
  if (!opts.userId) return null;

  const params: any[] = [opts.userId, opts.sessionId];
  const conditions = [
    `s.user_id = $${startParamIndex}`,
    `s.id <> $${startParamIndex + 1}`,
    `s.archived = 0`,
  ];

  if (opts.projectId) {
    params.push(opts.projectId);
    conditions.push(`s.project_id = $${startParamIndex + 2}`);
  } else if (opts.cwd) {
    // Project-less sessions are rare. Exact cwd matching is safer than falling
    // back to basename(project), which caused cross-project leakage.
    params.push(opts.cwd);
    conditions.push(`s.project_id IS NULL`);
    conditions.push(`s.cwd = $${startParamIndex + 2}`);
  } else {
    return null;
  }

  return { sql: conditions.join(' AND '), params };
}

/**
 * Build a personal `<memory-context>` XML block for the current Pi session.
 *
 * Scope invariant:
 *   - same `sessions.user_id`
 *   - same `sessions.project_id` when available
 *   - current session excluded
 *
 * Returns null when there is no safe scope or no recent signal.
 */
export async function buildMemoryContext(opts: BuildMemoryContextOpts): Promise<string | null> {
  const scope = buildScopeWhere(opts, 1);
  if (!scope) return null;

  try {
    let cards: SessionMemoryCard[] = [];
    if (opts.userId) {
      try {
        cards = await getMemoryCardsForContext({
          userId: opts.userId,
          projectId: opts.projectId,
          sessionId: opts.sessionId,
          limit: 3,
        });
      } catch (err) {
        // Migration may not be applied yet during rolling deploy/dev startup.
        // Fall back to sessions + session_file_edits rather than dropping memory.
        console.warn(`[pi-memory] continuity cards unavailable, using fallback: ${(err as Error).message}`);
        cards = [];
      }
    }

    const sessions = cards.length > 0 ? [] : await query<RecentSessionRow>(
      `SELECT s.id,
              s.name,
              s.summary,
              s.files_edited,
              s.updated_at::text AS updated_at,
              s.turn_count
         FROM sessions s
        WHERE ${scope.sql}
          AND COALESCE(s.turn_count, 0) > 0
        ORDER BY s.updated_at DESC
        LIMIT 3`,
      scope.params,
    );

    const files = await query<RecentFileRow>(
      `SELECT sfe.session_id,
              s.name AS session_name,
              sfe.file_path,
              sfe.tool_name,
              sfe.created_at::text AS touched_at
         FROM session_file_edits sfe
         JOIN sessions s ON s.id = sfe.session_id
        WHERE ${scope.sql}
        ORDER BY sfe.created_at DESC
        LIMIT 3`,
      scope.params,
    );

    if (cards.length === 0 && sessions.length === 0 && files.length === 0) return null;

    const label = opts.projectLabel || opts.projectId || (opts.cwd ? basename(opts.cwd) : 'unknown');
    const lines: string[] = [];
    lines.push(`<memory-context project="${escapeXml(label)}" scope="personal-user-project" source="tower-pg" version="2">`);

    if (cards.length > 0) {
      appendCardLines(lines, cards);
    }

    if (sessions.length > 0) {
      lines.push('## 최근 작업 힌트');
      for (const s of sessions.slice(0, 3)) {
        const changed = safeJsonArray(s.files_edited).map((f) => basename(f));
        const fileStr = changed.length > 0 ? ` (${changed.slice(0, 3).join(', ')})` : '';
        const subject = s.summary?.trim() || s.name || `turns=${s.turn_count ?? 0}`;
        lines.push(`- [${formatDate(s.updated_at)}] ${truncate(subject, 110)}${fileStr}`);
      }
      lines.push('자세한 과거 맥락이 필요하면 memory_search를 사용한다.');
    }

    if (cards.length === 0 && files.length > 0) {
      lines.push('## 최근 작업 힌트');
      const seen = new Set<string>();
      for (const f of files.slice(0, 3)) {
        if (seen.has(f.file_path)) continue;
        seen.add(f.file_path);
        const fileName = basename(f.file_path);
        lines.push(`- [${formatDate(f.touched_at)}] ${fileName}: ${truncate(f.session_name, 90)}`);
      }
      lines.push('자세한 과거 맥락이 필요하면 memory_search를 사용한다.');
    }

    lines.push('</memory-context>');
    return lines.join('\n');
  } catch (err) {
    console.warn(`[pi-memory] buildMemoryContext failed: ${(err as Error).message}`);
    return null;
  }
}

// Exported for tests. Keep narrow; callers should use buildMemoryContext().
export const __memoryContextTest = { buildScopeWhere, safeJsonArray, escapeXml, formatDate };
