import { query as pgQuery } from '../../db/pg-repo.js';
import { extractTextFromContent } from '../../utils/text.js';
import { getAccessibleProjectIds } from '../pm/project-membership-manager.js';

/**
 * Full-text search service (PostgreSQL tsvector) — now with smart ranking.
 *
 * Primary path: tsvector with the 'simple' config via expression-indexed GIN
 * (migration 029). websearch_to_tsquery gives boolean ops ("phrase", AND, OR,
 * -exclusion) for free.
 *
 * Session scoring blends multiple signals:
 *   score = ts_rank_cd(...)                                -- text match
 *         × exp(-days_since_update / 30)                   -- recency decay
 *         × (caller_favorited ? 1.5 : 1.0)                 -- *caller's* star
 *         × (own_session ? 1.3 : 1.0)                      -- mine > shared
 *         × (current_project ? 1.3 : 1.0)                  -- in-context boost
 *
 * NOTE: favorite is per-user (user_session_favorites table, 2026-05-22). The
 * boost reflects the searching user's bookmarks, not someone else's.
 *
 * Message scoring uses a two-stage plan to stay fast on common tokens:
 *   Stage 1: top 100 recent matches via tsvector + recency LIMIT (fast)
 *   Stage 2: re-rank those 100 by ts_rank_cd × recency_decay (cheap)
 * This avoids the 12-second full-corpus ORDER BY ts_rank_cd we hit before.
 *
 * Fallback: if tsvector returns nothing, retry with pg_trgm ILIKE using the
 * legacy indexes from migration 011.
 *
 * Highlight format: ts_headline wraps matches with control-char markers
 *   START = U+0002 (STX)   END = U+0003 (ETX)
 * so the client can split on these and render <mark> as React elements
 * (no innerHTML, no XSS surface).
 */

// Control-char markers for ts_headline — never appear in real text.
// STX (U+0002) and ETX (U+0003). The client splits on these and renders
// <mark> as React elements (no dangerouslySetInnerHTML, no XSS surface).
export const HIGHLIGHT_START = '';
export const HIGHLIGHT_END = '';

const HEADLINE_OPTS = [
  `StartSel=${HIGHLIGHT_START}`,
  `StopSel=${HIGHLIGHT_END}`,
  'MaxWords=30',
  'MinWords=12',
  'ShortWord=0',
  'MaxFragments=1',
].join(', ');

// Ranking constants — tune these if logs show different user behavior.
const RECENCY_HALF_LIFE_DAYS = 30;       // exp(-days / 30) → 30d old = 0.37×
const FAVORITE_BOOST = 1.5;
const OWN_SESSION_BOOST = 1.3;
const CURRENT_PROJECT_BOOST = 1.3;
const MESSAGE_STAGE1_POOL = 100;         // rerank top-N most recent matches

export function normalizeMessageSearchText(content: string): string {
  const text = extractTextFromContent(content || '');
  // Keep the TypeScript snippet path aligned with the SQL-side
  // tower_message_search_document() migration function: index human text,
  // not opaque tool inputs, base64 blobs, or huge serialized URLs.
  return text
    .replace(/https?:\/\/\S{500,}/g, ' ')
    .replace(/\b[\w+/=-]{256,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function messageSnippet(content: string, q: string): string {
  const text = normalizeMessageSearchText(content);
  if (!text) return '';
  const terms = q.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [];
  const lower = text.toLowerCase();
  const hit = terms.map(t => lower.indexOf(t)).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, hit - 180);
  const end = Math.min(text.length, hit + 900);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export interface SearchResult {
  type: 'session' | 'message' | 'memory_card';
  sessionId: string;
  /** URL-friendly short code for `/s/<shortCode>` links when available. */
  sessionShortCode?: string;
  sessionName: string;
  /** Human-friendly project name for `project · session` labels. */
  projectName?: string | null;
  /** Plain text for sessions; may contain HIGHLIGHT_START/END markers for messages. */
  snippet: string;
  /** Also set for sessions so client can highlight the hit in the session name. */
  nameSnippet?: string;
  rank: number;
  /** True if this hit lives in an archived (history) session. */
  archived?: boolean;
  createdAt: string;
  /** Memory-card specific: why this past session matters for continuity. */
  memoryTitle?: string;
  memoryOutcome?: string;
  memoryNextActions?: string[];
  memoryCautions?: string[];
}

export interface SearchOptions {
  userId?: number;
  role?: string;
  /** Total cap on the returned array — legacy behavior. Default 20, max 50. */
  limit?: number;
  /** Max session hits (default: ceil(limit/2)). */
  sessionLimit?: number;
  /** Max message hits (default: limit). */
  messageLimit?: number;
  /** Max continuity memory-card hits (default: ceil(limit/2)). */
  memoryLimit?: number;
  /** If true, include archived (history) sessions and their messages. */
  includeArchived?: boolean;
  /** If true, default per-section limits are larger for deeper research. */
  deep?: boolean;
  /** Current project ID — matches get a 1.3× ranking boost. */
  currentProjectId?: string | null;
}

/**
 * Build SQL visibility clause for session-based queries.
 *
 * Logic (same as getSessions):
 *   admin → no filter
 *   member → (own sessions) OR (project member + visibility='project')
 */
function buildVisibilityFilter(
  accessibleIds: string[] | null,
  userId: number | undefined,
  startIdx: number,
): { clause: string; params: any[]; nextIdx: number } {
  if (accessibleIds === null) {
    return { clause: '', params: [], nextIdx: startIdx };
  }
  const params: any[] = [];
  const conditions: string[] = [];
  if (userId) {
    conditions.push(`s.user_id = $${startIdx}`);
    params.push(userId);
    startIdx++;
  }
  if (accessibleIds.length > 0) {
    conditions.push(`(s.project_id = ANY($${startIdx}) AND s.visibility = 'project')`);
    params.push(accessibleIds);
    startIdx++;
  }
  if (conditions.length === 0) {
    return { clause: 'AND FALSE', params: [], nextIdx: startIdx };
  }
  return {
    clause: `AND (${conditions.join(' OR ')})`,
    params,
    nextIdx: startIdx,
  };
}

function archivedClause(includeArchived: boolean): string {
  // Keep the operator explicit so the planner can still use indexes.
  return includeArchived ? '' : "AND (s.archived IS NULL OR s.archived = 0)";
}

async function searchSessionsTsv(
  q: string,
  limit: number,
  accessibleIds: string[] | null,
  userId: number | undefined,
  includeArchived: boolean,
  currentProjectId: string | null | undefined,
): Promise<SearchResult[]> {
  const vis = buildVisibilityFilter(accessibleIds, userId, 3);
  // Parameter slots: $1=q, $2=limit, ...vis, then HEADLINE_OPTS, userId-for-own-boost, projectId-for-project-boost
  const headlineIdx = vis.nextIdx;
  const userIdIdx = headlineIdx + 1;
  const projectIdx = userIdIdx + 1;

  const params = [
    q,
    limit,
    ...vis.params,
    HEADLINE_OPTS,
    userId ?? null,
    currentProjectId ?? null,
  ];

  // Note: exp(-extract(epoch from age) / secs_in_30d)
  // age in seconds ÷ 2,592,000 = age in 30-day halves; exp(-x) gives decay.
  const rows = await pgQuery(`
    SELECT
      s.id,
      s.short_code,
      s.name,
      p.name AS project_name,
      s.summary,
      s.created_at,
      (s.archived IS NOT NULL AND s.archived = 1) AS archived,
      ts_rank_cd(
        to_tsvector('simple', coalesce(s.name,'') || ' ' || coalesce(s.summary,'')),
        websearch_to_tsquery('simple', $1)
      )
      * exp(-GREATEST(0, EXTRACT(EPOCH FROM (NOW() - s.updated_at))) / (${RECENCY_HALF_LIFE_DAYS} * 86400.0))
      * (CASE WHEN $${userIdIdx}::int IS NOT NULL AND usf.session_id IS NOT NULL THEN ${FAVORITE_BOOST}::float ELSE 1.0::float END)
      * (CASE WHEN $${userIdIdx}::int IS NOT NULL AND s.user_id = $${userIdIdx}::int THEN ${OWN_SESSION_BOOST}::float ELSE 1.0::float END)
      * (CASE WHEN $${projectIdx}::text IS NOT NULL AND s.project_id::text = $${projectIdx}::text THEN ${CURRENT_PROJECT_BOOST}::float ELSE 1.0::float END)
      AS score,
      ts_headline('simple',
        coalesce(s.summary, s.name, ''),
        websearch_to_tsquery('simple', $1),
        $${headlineIdx}
      ) AS snippet,
      ts_headline('simple',
        coalesce(s.name,''),
        websearch_to_tsquery('simple', $1),
        $${headlineIdx}
      ) AS name_snippet
    FROM sessions s
    LEFT JOIN projects p ON p.id = s.project_id
    LEFT JOIN user_session_favorites usf
      ON usf.session_id = s.id AND usf.user_id = $${userIdIdx}::int
    WHERE to_tsvector('simple', coalesce(s.name,'') || ' ' || coalesce(s.summary,''))
          @@ websearch_to_tsquery('simple', $1)
      ${archivedClause(includeArchived)}
      ${vis.clause}
    ORDER BY score DESC, s.updated_at DESC
    LIMIT $2
  `, params);

  return rows.map((r: any) => ({
    type: 'session' as const,
    sessionId: r.id,
    sessionShortCode: r.short_code || undefined,
    sessionName: r.name,
    projectName: r.project_name || null,
    snippet: r.snippet || r.name || '',
    nameSnippet: r.name_snippet || r.name || '',
    rank: Number(r.score) || 0,
    archived: !!r.archived,
    createdAt: r.created_at,
  }));
}

async function searchMemoryCardsTsv(
  q: string,
  limit: number,
  accessibleIds: string[] | null,
  userId: number | undefined,
  includeArchived: boolean,
  currentProjectId: string | null | undefined,
): Promise<SearchResult[]> {
  const vis = buildVisibilityFilter(accessibleIds, userId, 3);
  const headlineIdx = vis.nextIdx;
  const userIdIdx = headlineIdx + 1;
  const projectIdx = userIdIdx + 1;
  const params = [q, limit, ...vis.params, HEADLINE_OPTS, userId ?? null, currentProjectId ?? null];

  const rows = await pgQuery(`
    WITH card_docs AS (
      SELECT
        smc.*,
        s.name AS session_name,
        s.short_code AS session_short_code,
        s.created_at AS session_created_at,
        s.updated_at AS session_updated_at,
        s.user_id AS session_user_id,
        s.project_id AS session_project_id,
        (s.archived IS NOT NULL AND s.archived = 1) AS archived,
        p.name AS project_name,
        COALESCE(smc.covered_message_created_at, smc.updated_at) AS memory_date,
        CONCAT_WS(' ',
          smc.title,
          smc.outcome,
          smc.pain_points::text,
          smc.resolved::text,
          smc.steps_taken::text,
          smc.next_actions::text,
          smc.artifacts::text,
          smc.decisions::text,
          smc.cautions::text,
          smc.touched_files::text
        ) AS doc
      FROM session_memory_cards smc
      JOIN sessions s ON s.id = smc.session_id
      LEFT JOIN projects p ON p.id = s.project_id
      WHERE smc.generation_status = 'success'
        ${archivedClause(includeArchived)}
        ${vis.clause}
    )
    SELECT
      session_id,
      session_short_code,
      session_name,
      project_name,
      archived,
      memory_date,
      title,
      outcome,
      next_actions,
      cautions,
      ts_rank_cd(to_tsvector('simple', doc), websearch_to_tsquery('simple', $1))
        * exp(-GREATEST(0, EXTRACT(EPOCH FROM (NOW() - memory_date))) / (${RECENCY_HALF_LIFE_DAYS} * 86400.0))
        * (CASE WHEN $${userIdIdx}::int IS NOT NULL AND session_user_id = $${userIdIdx}::int THEN ${OWN_SESSION_BOOST}::float ELSE 1.0::float END)
        * (CASE WHEN $${projectIdx}::text IS NOT NULL AND session_project_id::text = $${projectIdx}::text THEN ${CURRENT_PROJECT_BOOST}::float ELSE 1.0::float END)
      AS score,
      ts_headline('simple', doc, websearch_to_tsquery('simple', $1), $${headlineIdx}) AS snippet
    FROM card_docs
    WHERE to_tsvector('simple', doc) @@ websearch_to_tsquery('simple', $1)
    ORDER BY score DESC, memory_date DESC
    LIMIT $2
  `, params);

  return rows.map((r: any) => ({
    type: 'memory_card' as const,
    sessionId: r.session_id,
    sessionShortCode: r.session_short_code || undefined,
    sessionName: r.session_name,
    projectName: r.project_name || null,
    snippet: r.snippet || r.outcome || r.title || '',
    nameSnippet: r.title || r.session_name || '',
    rank: Number(r.score) || 0,
    archived: !!r.archived,
    createdAt: r.memory_date,
    memoryTitle: r.title || undefined,
    memoryOutcome: r.outcome || undefined,
    memoryNextActions: Array.isArray(r.next_actions) ? r.next_actions : [],
    memoryCautions: Array.isArray(r.cautions) ? r.cautions : [],
  }));
}

async function searchMessagesTsv(
  q: string,
  limit: number,
  accessibleIds: string[] | null,
  userId: number | undefined,
  includeArchived: boolean,
): Promise<SearchResult[]> {
  const vis = buildVisibilityFilter(accessibleIds, userId, 3);
  const poolSize = Math.max(limit * 4, MESSAGE_STAGE1_POOL);
  const headlineIdx = vis.nextIdx;
  const params = [q, poolSize, ...vis.params, HEADLINE_OPTS];

  // Two-stage plan: CTE grabs the top-N most recent matches using the tsvector
  // GIN index (cheap because it's limited). Outer SELECT re-ranks just that
  // pool with ts_rank_cd × recency_decay. The recompute cost on poolSize=100
  // rows is ~10-30ms even on common tokens.
  const rows = await pgQuery(`
    WITH recent_matches AS (
      SELECT m.id, m.session_id, m.content, m.created_at
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE to_tsvector('simple', tower_message_search_document(m.content))
            @@ websearch_to_tsquery('simple', $1)
        AND m.role IN ('user', 'assistant')
        ${archivedClause(includeArchived)}
        ${vis.clause}
      ORDER BY m.created_at DESC
      LIMIT $2
    )
    SELECT
      rm.id,
      rm.session_id,
      rm.created_at,
      rm.content,
      s.name AS session_name,
      s.short_code AS session_short_code,
      p.name AS project_name,
      (s.archived IS NOT NULL AND s.archived = 1) AS archived,
      ts_rank_cd(
        to_tsvector('simple', tower_message_search_document(rm.content)),
        websearch_to_tsquery('simple', $1)
      )
      * exp(-GREATEST(0, EXTRACT(EPOCH FROM (NOW() - rm.created_at))) / (${RECENCY_HALF_LIFE_DAYS} * 86400.0))
      AS score,
      ts_headline('simple',
        tower_message_search_document(rm.content),
        websearch_to_tsquery('simple', $1),
        $${headlineIdx}
      ) AS snippet
    FROM recent_matches rm
    JOIN sessions s ON s.id = rm.session_id
    LEFT JOIN projects p ON p.id = s.project_id
    ORDER BY score DESC, rm.created_at DESC
    LIMIT ${Math.max(1, limit)}
  `, params);

  return rows.map((r: any) => ({
    type: 'message' as const,
    sessionId: r.session_id,
    sessionShortCode: r.session_short_code || undefined,
    sessionName: r.session_name,
    projectName: r.project_name || null,
    snippet: messageSnippet(r.content || '', q) || '[non-text tool payload omitted]',
    rank: Number(r.score) || 0,
    archived: !!r.archived,
    createdAt: r.created_at,
  }));
}

/**
 * Legacy pg_trgm / ILIKE fallback — used only when tsvector returns nothing.
 * Still hits the trgm GIN indexes from migration 011 so it stays fast.
 * Doesn't apply smart ranking — this path only fires when tsvector missed,
 * typically very short / unusual tokens where fancy scoring adds no signal.
 */
async function searchFallbackTrgm(
  q: string,
  limit: number,
  accessibleIds: string[] | null,
  userId: number | undefined,
  includeArchived: boolean,
): Promise<SearchResult[]> {
  const out: SearchResult[] = [];

  // Sessions
  try {
    const vis = buildVisibilityFilter(accessibleIds, userId, 3);
    const rows = await pgQuery(`
      SELECT s.id, s.short_code, s.name, p.name AS project_name, s.summary, s.created_at,
        (s.archived IS NOT NULL AND s.archived = 1) AS archived
      FROM sessions s
      LEFT JOIN projects p ON p.id = s.project_id
      WHERE (s.name ILIKE '%' || $1 || '%' OR COALESCE(s.summary,'') ILIKE '%' || $1 || '%')
        ${archivedClause(includeArchived)}
        ${vis.clause}
      ORDER BY s.updated_at DESC
      LIMIT $2
    `, [q, limit, ...vis.params]);
    for (const r of rows) {
      out.push({
        type: 'session',
        sessionId: r.id,
        sessionShortCode: r.short_code || undefined,
        sessionName: r.name,
        projectName: r.project_name || null,
        snippet: r.summary || r.name || '',
        rank: 0,
        archived: !!r.archived,
        createdAt: r.created_at,
      });
    }
  } catch (err) { console.error('[search] trgm session fallback error:', err); }

  // Messages — keep a light context snippet with highlight markers
  try {
    const vis = buildVisibilityFilter(accessibleIds, userId, 3);
    const rows = await pgQuery(`
      SELECT m.id, m.content, m.session_id, m.created_at,
        s.name AS session_name, s.short_code AS session_short_code, p.name AS project_name,
        (s.archived IS NOT NULL AND s.archived = 1) AS archived
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      LEFT JOIN projects p ON p.id = s.project_id
      WHERE m.content ILIKE '%' || $1 || '%'
        AND m.role IN ('user', 'assistant')
        ${archivedClause(includeArchived)}
        ${vis.clause}
      ORDER BY m.created_at DESC
      LIMIT $2
    `, [q, limit, ...vis.params]);
    for (const r of rows) {
      const body = normalizeMessageSearchText(r.content || '');
      const idx = body.toLowerCase().indexOf(q.toLowerCase());
      const start = Math.max(0, idx - 60);
      const end = Math.min(body.length, idx + q.length + 100);
      const before = (start > 0 ? '…' : '') + body.slice(start, idx);
      const match = HIGHLIGHT_START + body.slice(idx, idx + q.length) + HIGHLIGHT_END;
      const after = body.slice(idx + q.length, end) + (end < body.length ? '…' : '');
      out.push({
        type: 'message',
        sessionId: r.session_id,
        sessionShortCode: r.session_short_code || undefined,
        sessionName: r.session_name,
        projectName: r.project_name || null,
        snippet: before + match + after,
        rank: 0,
        archived: !!r.archived,
        createdAt: r.created_at,
      });
    }
  } catch (err) { console.error('[search] trgm message fallback error:', err); }

  return out;
}

export async function search(q: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
  const query = (q || '').trim();
  if (!query || query.length < 2) return [];

  const totalLimit = Math.min(opts.limit ?? 20, 50);
  const deep = !!opts.deep;
  // Search is sectioned: continuity memory, session summaries, and raw message
  // evidence each get their own top-N. `limit` is a base size, not a global cap.
  const memoryLimit = Math.max(1, opts.memoryLimit ?? (deep ? totalLimit : Math.min(8, Math.ceil(totalLimit / 2))));
  const sessionLimit = Math.max(1, opts.sessionLimit ?? (deep ? totalLimit : Math.min(8, Math.ceil(totalLimit / 2))));
  const messageLimit = Math.max(1, opts.messageLimit ?? (deep ? totalLimit : totalLimit));
  const includeArchived = !!opts.includeArchived;
  const currentProjectId = opts.currentProjectId ?? null;

  const accessibleIds = (opts.userId && opts.role)
    ? await getAccessibleProjectIds(opts.userId, opts.role)
    : null;

  let sessionHits: SearchResult[] = [];
  let messageHits: SearchResult[] = [];
  let memoryHits: SearchResult[] = [];

  try {
    [sessionHits, memoryHits, messageHits] = await Promise.all([
      searchSessionsTsv(query, sessionLimit, accessibleIds, opts.userId, includeArchived, currentProjectId),
      searchMemoryCardsTsv(query, memoryLimit, accessibleIds, opts.userId, includeArchived, currentProjectId),
      searchMessagesTsv(query, messageLimit, accessibleIds, opts.userId, includeArchived),
    ]);
  } catch (err) {
    console.error('[search] tsvector path error, will try fallback:', err);
  }

  if (sessionHits.length === 0 && memoryHits.length === 0 && messageHits.length === 0) {
    const fallback = await searchFallbackTrgm(query, totalLimit, accessibleIds, opts.userId, includeArchived);
    return fallback.slice(0, totalLimit);
  }

  // Memory cards first, then sessions, then messages. Clients render these as
  // separate sections; memory cards are concise handoff summaries and should be
  // the most actionable search surface when available.
  const combined = [...memoryHits, ...sessionHits, ...messageHits];
  return combined.slice(0, memoryLimit + sessionLimit + messageLimit);
}
