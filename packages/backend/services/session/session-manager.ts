import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, execute } from '../../db/pg-repo.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getAccessibleProjectIds } from '../pm/project-membership-manager.js';
import { findJsonlFileForSession } from '../workspace/jsonl-utils.js';
import { getAllRunningSessionIds } from '../../engines/index.js';
import { rehydratePiSessionFromMessages } from '../../engines/pi/rehydrate.js';
import type { RehydrateInputMessage } from '../../engines/types.js';
import { getConfigDir } from '../auth/credential-store.js';
import { config, normalizePiSessionModelId } from '../../config.js';
import { generateShortCode } from './short-code.js';
import { humanTouchedSql } from './agent-session/classification.js';
export type { SessionMeta } from '@tower/shared';
import type { SessionMeta } from '@tower/shared';

/** Postgres unique_violation 코드 — short_code 충돌 retry 판별용. */
const PG_UNIQUE_VIOLATION = '23505';
const SHORT_CODE_MAX_RETRIES = 5;
const LEGACY_UNCATEGORIZED_DECK_LABELS = new Set(['temp', '미분류']);

/**
 * Normalize user-facing deck labels at the session boundary.
 *
 * `null` means "no deck". The sidebar renders those rows under its synthetic
 * localized Uncategorized group, so storing a real deck named `미분류` creates
 * two visually identical buckets. Treat the old system labels as legacy
 * ungrouped markers while preserving all real/special labels (`ai_thread`,
 * `project_ai`, custom deck names, etc.).
 */
function normalizeSessionDeckLabel(label: string | null | undefined): string | null {
  const trimmed = typeof label === 'string' ? label.trim() : '';
  if (!trimmed) return null;
  if (LEGACY_UNCATEGORIZED_DECK_LABELS.has(trimmed)) return null;
  return trimmed;
}

/**
 * Check if a model string is compatible with an engine.
 * Mirrors the matchesEngine guard in ws-handler.ts.
 *
 * - claude: starts with "claude-"
 * - pi: contains "/" (provider/modelId format, e.g. "openrouter/moonshotai/kimi-k2.6")
 * - local: anything else
 */
function modelMatchesEngine(model: string | null | undefined, engine: string): boolean {
  if (!model) return false;
  if (engine === 'claude') return model.startsWith('claude-');
  if (engine === 'pi') return model.includes('/');
  if (engine === 'local') return !model.startsWith('claude-') && !model.includes('/');
  return false;
}

export async function createSession(name: string, cwd: string, userId?: number, projectId?: string | null, engine?: string, roomId?: string | null, sourceMessageId?: string | null, parentSessionId?: string | null, label?: string, modelUsed?: string | null, creation?: { visibility?: 'private' | 'project'; agentCreationCommandId?: string; harness?: { id: string; version: number; runtimeProfileId: string; runtimeProfileVersion: number } }): Promise<SessionMeta> {
  const id = uuidv4();

  if (projectId) {
    const project = await queryOne<{ lifecycle_status: string | null; archived: number | null }>(
      'SELECT lifecycle_status, archived FROM projects WHERE id = $1', [projectId],
    );
    if (!project || project.archived || (project.lifecycle_status ?? 'active') !== 'active') {
      throw new Error('Agent is retired; new sessions are disabled');
    }
  }

  // Validate engine availability
  const resolvedEngine = engine || config.defaultEngine || 'pi';
  if (resolvedEngine === 'claude' && !config.claudeEnabled) {
    throw new Error('Claude engine is archived. Use Pi engine instead, or explicitly enable the archived Claude engine with TOWER_ENABLE_ARCHIVED_CLAUDE_ENGINE=true and CLAUDE_ENABLED=true.');
  }
  if (resolvedEngine === 'pi' && !config.piEnabled) {
    throw new Error('Pi engine is disabled. Use Claude engine instead or enable Pi with PI_ENABLED=true');
  }

  // Sessions within a project default to 'project' visibility (shared with members)
  const visibility = creation?.visibility || (projectId ? 'project' : 'private');
  const normalizedLabel = normalizeSessionDeckLabel(label);

  // Pin the SDK config dir at create time so it remains stable even if the
  // project is later reassigned to a different Claude account. NULL is fine
  // when no project / no account assignment — runtime callers fall back to
  // the default-account lookup. See migration 053 / audit decision.
  const configDir = (await getConfigDir(projectId)) ?? null;

  // Resolve model_used. Priority:
  //   1. explicit `modelUsed` argument from caller (e.g. spawn-rpc, panel creator).
  //   2. parent session's model_used IF engine matches (panel inherits from parent).
  //   3. NULL — leave it for the first turn to set via engine_done.
  // Engine-mismatch guard: NEVER write a model that doesn't match the engine
  // (e.g. claude-sonnet-4-6 into a pi session). Mismatched model_used causes
  // the ws-handler "model mismatch: dropping ..." path → silent fallback to
  // customModelKeys[0], which can land on a model with auth issues.
  // 결정: workspace/decisions/2026-05-17-pi-panel-session-model-used-bug.md
  let resolvedModelUsed: string | null = null;
  if (resolvedEngine === 'pi') {
    if (modelUsed !== undefined && modelUsed !== null) {
      resolvedModelUsed = normalizePiSessionModelId(modelUsed);
    } else if (parentSessionId) {
      const parentRow = await queryOne<{ model_used: string | null }>(
        'SELECT model_used FROM sessions WHERE id = $1',
        [parentSessionId]
      );
      resolvedModelUsed = normalizePiSessionModelId(parentRow?.model_used);
    }
  } else if (modelMatchesEngine(modelUsed, resolvedEngine)) {
    resolvedModelUsed = modelUsed!;
  } else if (parentSessionId) {
    const parentRow = await queryOne<{ model_used: string | null }>(
      'SELECT model_used FROM sessions WHERE id = $1',
      [parentSessionId]
    );
    if (parentRow && modelMatchesEngine(parentRow.model_used, resolvedEngine)) {
      resolvedModelUsed = parentRow.model_used!;
    }
  }

  // INSERT with short_code — 31^8 ≈ 8.5×10^11 공간이라 충돌 거의 0 이지만
  // partial unique index 위반 시 안전하게 재시도 (최대 5회).
  // 결정: workspace/decisions/2026-05-24-url-routing-phase-2-short-code.md
  let shortCode = '';
  for (let attempt = 0; attempt < SHORT_CODE_MAX_RETRIES; attempt++) {
    shortCode = generateShortCode();
    try {
      await execute(`
        INSERT INTO sessions (id, short_code, name, cwd, user_id, project_id, engine, room_id, source_message_id, parent_session_id, visibility, label, config_dir, model_used, agent_creation_command_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      `, [id, shortCode, name, cwd, userId || null, projectId || null, resolvedEngine, roomId || null, sourceMessageId || null, parentSessionId || null, visibility, normalizedLabel, configDir, resolvedModelUsed, creation?.agentCreationCommandId || null]);
      break;
    } catch (err: any) {
      if (err?.code === PG_UNIQUE_VIOLATION && attempt < SHORT_CODE_MAX_RETRIES - 1) {
        continue;
      }
      throw err;
    }
  }

  // Pin the Project Primary Agent identity at Session creation. Legacy Sessions
  // without a snapshot are pinned lazily on their next Agent-first turn.
  if (config.agentFirstEnabled && projectId) {
    try {
      const { getSessionProjectAgentRuntimeProfile } = await import('../pm/project-agent-profile.js');
      await getSessionProjectAgentRuntimeProfile(id, projectId);
    } catch (err: any) {
      // Session creation must remain available if an additive Agent-first
      // snapshot cannot be written; runtime lazy pinning will retry safely.
      console.warn(`[sessions] Project Agent profile pin deferred for ${id}: ${err?.message || err}`);
    }
  }

  // Pin the Agent's Harness before its first runtime is assembled. This is
  // additive and best-effort during rollout; PiEngine retries the same atomic
  // pin on first run, so a temporarily unavailable migration cannot create a
  // mutable per-turn binding.
  if (resolvedEngine === 'pi') {
    try {
      const { getOrPinSessionHarnessSnapshot } = await import('../harness/harness-store.js');
      await getOrPinSessionHarnessSnapshot({
        sessionId: id,
        projectId: projectId || undefined,
        requestedEngine: 'pi',
        requestedModel: resolvedModelUsed || undefined,
        requestedHarnessId: creation?.harness?.id,
        requestedHarnessVersion: creation?.harness?.version,
        requestedRuntimeProfileId: creation?.harness?.runtimeProfileId,
        requestedRuntimeProfileVersion: creation?.harness?.runtimeProfileVersion,
        invocationKind: 'session',
      });
    } catch (err: any) {
      console.warn(`[sessions] Harness snapshot pin deferred for ${id}: ${err?.message || err}`);
    }
  }

  // Initial engine-history row — anchors the audit trail at creation time.
  // from_engine=NULL signals "this is the create row, not a switch".
  // See: workspace/decisions/2026-05-19-engine-hard-switch-design.md
  await execute(
    `INSERT INTO session_engine_history (session_id, from_engine, to_engine, at_turn, reason, switched_by)
     VALUES ($1, NULL, $2, 0, 'create', $3)`,
    [id, resolvedEngine, userId || null]
  );

  // Resolve ownerUsername so the frontend "My Sessions" filter matches this
  // session immediately after creation — without it, the returned SessionMeta
  // has ownerUsername=undefined, and `s.ownerUsername === currentUsername`
  // silently drops the brand-new session until the next full refresh.
  let ownerUsername: string | null = null;
  if (userId) {
    const userRow = await queryOne<{ username: string }>(
      'SELECT username FROM users WHERE id = $1',
      [userId]
    );
    ownerUsername = userRow?.username ?? null;
  }

  return {
    id,
    shortCode,
    name,
    cwd,
    tags: [],
    favorite: false,
    totalCost: 0,
    totalTokens: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectId: projectId || null,
    engine: resolvedEngine,
    roomId: roomId || null,
    parentSessionId: parentSessionId || null,
    sourceMessageId: sourceMessageId || null,
    ownerUsername,
    visibility,
    label: normalizedLabel,
    agentCreationCommandId: creation?.agentCreationCommandId || null,
    configDir,
    modelUsed: resolvedModelUsed || undefined,
  };
}

/** Get AI Panel sessions for a specific room + user.
 *  Returns (a) the caller's own side-panel threads AND (b) the shared
 *  channel AI session (label='channel_ai', user_id=NULL) for the room.
 *  Channel AI is system-owned but must appear in every member's AI panel
 *  so anyone can open the room's persistent @ai conversation. */
export async function getPanelSessions(roomId: string, userId: number): Promise<SessionMeta[]> {
  const rows = await query(
    `SELECT * FROM sessions
       WHERE room_id = $1
         AND (user_id = $2 OR (user_id IS NULL AND label = 'channel_ai'))
         AND (archived IS NULL OR archived = 0)
       ORDER BY
         CASE WHEN label = 'channel_ai' THEN 0 ELSE 1 END,
         updated_at DESC`,
    [roomId, userId]
  ) as any[];
  const favs = await getUserFavoriteSessionIds(userId);
  return rows.map(r => mapRow(r, favs));
}

/** Get AI Panel sessions for a parent session + user.
 *
 * Current-parent threads are shown first. When the parent belongs to a project,
 * the caller's own AI Panel threads from the same project are appended, followed
 * by explicitly shared project AI threads. Agent backing sessions remain scoped
 * to the current parent session instead of leaking across the project.
 */
export async function getSessionPanelSessions(parentSessionId: string, userId: number, opts: { includeProject?: boolean; role?: string } = {}): Promise<SessionMeta[]> {
  const accessibleIds = await getAccessibleProjectIds(userId, opts.role || 'member');
  const rows = await query(
    `WITH parent AS (
       SELECT project_id FROM sessions WHERE id = $1
     ), scoped AS (
       SELECT s.*, 0 AS ai_panel_rank, 'session' AS ai_panel_scope
         FROM sessions s
        WHERE s.parent_session_id = $1
          AND (s.user_id = $2 OR s.label = 'agent')
          AND (s.archived IS NULL OR s.archived = 0)
       UNION ALL
       SELECT s.*, 1 AS ai_panel_rank, 'project' AS ai_panel_scope
         FROM sessions s
         JOIN sessions origin ON origin.id = s.parent_session_id
         JOIN parent p ON p.project_id IS NOT NULL AND origin.project_id = p.project_id
        WHERE $3::boolean = TRUE
          AND s.user_id = $2
          AND s.parent_session_id IS DISTINCT FROM $1
          AND s.room_id IS NULL
          AND s.label = 'ai_thread'
          AND (s.archived IS NULL OR s.archived = 0)
       UNION ALL
       SELECT s.*, 2 AS ai_panel_rank, 'project' AS ai_panel_scope
         FROM sessions s
         JOIN parent p ON p.project_id IS NOT NULL AND s.project_id = p.project_id
        WHERE $3::boolean = TRUE
          AND s.id <> $1
          AND s.parent_session_id IS NULL
          AND s.room_id IS NULL
          AND s.label = 'project_ai'
          AND (s.user_id = $2 OR s.visibility = 'project')
          AND (s.archived IS NULL OR s.archived = 0)
     )
     SELECT * FROM scoped
      ORDER BY ai_panel_rank ASC, updated_at DESC`,
    [parentSessionId, userId, opts.includeProject === true]
  ) as any[];
  const favs = await getUserFavoriteSessionIds(userId);
  return rows
    .filter(r => isSessionListVisibleToUser(r, userId, accessibleIds))
    .map(r => ({ ...mapRow(r, favs), aiPanelScope: r.ai_panel_scope }));
}

/** Fields that represent real activity (chat turns, cost) — these bump updated_at.
 *  Metadata-only changes (label, favorite, tags, visibility) do NOT bump updated_at
 *  so that sidebar "last used" times remain accurate. */
const ACTIVITY_FIELDS = new Set(['cwd', 'claudeSessionId', 'piSessionFile', 'totalCost', 'totalTokens', 'modelUsed', 'summary', 'summaryAtTurn', 'turnCount', 'filesEdited']);

/**
 * Set or clear a session favorite *for one user*.
 *
 * Stored in `user_session_favorites` (junction table). The legacy
 * `sessions.favorite` column is no longer read — kept only for rollback safety.
 *
 * 결정: workspace/decisions/2026-05-22-per-user-session-favorites.md
 */
export async function setSessionFavorite(sessionId: string, userId: number, favorite: boolean): Promise<void> {
  if (favorite) {
    await execute(
      `INSERT INTO user_session_favorites (user_id, session_id) VALUES ($1, $2)
       ON CONFLICT (user_id, session_id) DO NOTHING`,
      [userId, sessionId],
    );
  } else {
    await execute(
      `DELETE FROM user_session_favorites WHERE user_id = $1 AND session_id = $2`,
      [userId, sessionId],
    );
  }
}

/**
 * Fetch the set of session IDs favorited by one user.
 * Returns empty Set when no userId — used by list endpoints to bulk-fill
 * `SessionMeta.favorite` without N+1 queries.
 */
async function getUserFavoriteSessionIds(userId: number | undefined): Promise<Set<string>> {
  if (!userId) return new Set();
  const rows = await query<{ session_id: string }>(
    `SELECT session_id FROM user_session_favorites WHERE user_id = $1`,
    [userId],
  );
  return new Set(rows.map(r => r.session_id));
}

export async function updateSession(id: string, updates: Partial<Pick<SessionMeta, 'name' | 'cwd' | 'claudeSessionId' | 'piSessionFile' | 'totalCost' | 'totalTokens' | 'tags' | 'modelUsed' | 'autoNamed' | 'summary' | 'summaryAtTurn' | 'turnCount' | 'filesEdited' | 'visibility' | 'label' | 'engine' | 'kind'>>) {
  const hasActivity = Object.keys(updates).some(k => ACTIVITY_FIELDS.has(k) && (updates as any)[k] !== undefined);
  const sets: string[] = hasActivity ? ['updated_at = CURRENT_TIMESTAMP'] : [];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.name !== undefined) { sets.push(`name = $${paramIndex++}`); values.push(updates.name); }
  if (updates.cwd !== undefined) { sets.push(`cwd = $${paramIndex++}`); values.push(updates.cwd); }
  if (updates.claudeSessionId !== undefined) { sets.push(`claude_session_id = $${paramIndex++}`); values.push(updates.claudeSessionId || null); }
  if (updates.piSessionFile !== undefined) { sets.push(`pi_session_file = $${paramIndex++}`); values.push(updates.piSessionFile || null); }
  if (updates.totalCost !== undefined) { sets.push(`total_cost = $${paramIndex++}`); values.push(updates.totalCost); }
  if (updates.totalTokens !== undefined) { sets.push(`total_tokens = $${paramIndex++}`); values.push(updates.totalTokens); }
  if (updates.tags !== undefined) { sets.push(`tags = $${paramIndex++}`); values.push(JSON.stringify(updates.tags)); }
  if (updates.modelUsed !== undefined) { sets.push(`model_used = $${paramIndex++}`); values.push(updates.modelUsed); }
  if (updates.autoNamed !== undefined) { sets.push(`auto_named = $${paramIndex++}`); values.push(updates.autoNamed); }
  if (updates.summary !== undefined) { sets.push(`summary = $${paramIndex++}`); values.push(updates.summary); }
  if (updates.summaryAtTurn !== undefined) { sets.push(`summary_at_turn = $${paramIndex++}`); values.push(updates.summaryAtTurn); }
  if (updates.turnCount !== undefined) { sets.push(`turn_count = $${paramIndex++}`); values.push(updates.turnCount); }
  if (updates.filesEdited !== undefined) { sets.push(`files_edited = $${paramIndex++}`); values.push(JSON.stringify(updates.filesEdited)); }
  if (updates.visibility !== undefined) { sets.push(`visibility = $${paramIndex++}`); values.push(updates.visibility); }
  if ('label' in updates) { sets.push(`label = $${paramIndex++}`); values.push(normalizeSessionDeckLabel(updates.label)); }
  if (updates.engine !== undefined) { sets.push(`engine = $${paramIndex++}`); values.push(updates.engine); }
  if (updates.kind !== undefined) { sets.push(`kind = $${paramIndex++}`); values.push(updates.kind); }

  // Defensive: if caller passed nothing actionable (e.g. only favorite, now handled
  // by setSessionFavorite), skip the no-op UPDATE which would otherwise produce
  // invalid SQL `SET  WHERE id = $1`.
  if (sets.length === 0) return;

  values.push(id);
  await execute(`UPDATE sessions SET ${sets.join(', ')} WHERE id = $${paramIndex}`, values);
}

/** Return the native resume identifier for a session's active engine. */
export function getEngineSessionId(session: Pick<SessionMeta, 'engine' | 'claudeSessionId' | 'piSessionFile'> | null | undefined): string | undefined {
  if (!session) return undefined;
  const engine = session.engine ?? 'claude';
  if (engine === 'pi') return session.piSessionFile || undefined;
  if (engine === 'claude') return session.claudeSessionId || undefined;
  return undefined;
}

/** Persist the native resume identifier into the column owned by `engine`. */
export async function claimEngineSessionId(towerSessionId: string, engine: string | null | undefined, engineSessionId: string): Promise<void> {
  if (!engineSessionId) return;
  const resolvedEngine = engine ?? 'claude';

  if (resolvedEngine === 'pi') {
    await execute(
      `UPDATE sessions SET pi_session_file = NULL
       WHERE pi_session_file = $1 AND id != $2`,
      [engineSessionId, towerSessionId]
    );
    await updateSession(towerSessionId, { piSessionFile: engineSessionId });
    return;
  }

  if (resolvedEngine === 'claude') {
    await execute(
      `UPDATE sessions SET claude_session_id = NULL
       WHERE claude_session_id = $1 AND id != $2`,
      [engineSessionId, towerSessionId]
    );
    await updateSession(towerSessionId, { claudeSessionId: engineSessionId });
  }
}

export type SessionListAccessRow = {
  user_id: number | null;
  project_id: string | null;
  visibility?: string | null;
  label?: string | null;
};

/**
 * Server-side visibility rule for session-list metadata.
 *
 * This is intentionally stricter than "can open messages": private session
 * metadata (title, owner, timestamps) is visible only to its owner, an explicit
 * share recipient handled elsewhere, or privileged roles. Project members see
 * other users' sessions only when visibility='project'.
 */
export function isSessionListVisibleToUser(
  row: SessionListAccessRow,
  userId: number | undefined,
  accessibleProjectIds: string[] | null,
): boolean {
  // No-auth/dev and admin/operator paths preserve the legacy full list.
  if (!userId || accessibleProjectIds === null) return true;

  // System-owned sessions (e.g. channel AI): visible only when the backing
  // project is accessible, except legacy project-less channel AI.
  if (row.user_id === null) {
    if (!row.project_id) return row.label === 'channel_ai';
    return accessibleProjectIds.includes(row.project_id);
  }

  // Project-less sessions are personal; never expose other users' legacy/temp
  // session metadata through the global list.
  if (!row.project_id) return row.user_id === userId;

  if (!accessibleProjectIds.includes(row.project_id)) return false;
  if (row.user_id === userId) return true;
  return row.visibility === 'project';
}

export type GetSessionsOptions = {
  /** Limit rows at SQL level after visibility/sidebar filters. Used by startup recent lists. */
  limit?: number;
  /** Restrict the list to one Project when lazily hydrating an Agent/Project home. */
  projectId?: string;
  /** Apply the user-facing sidebar first-class session filter before ORDER/LIMIT. */
  sidebarOnly?: boolean;
};

export async function getSessions(userId?: number, role?: string, options: GetSessionsOptions = {}): Promise<SessionMeta[]> {
  const limit = Number.isInteger(options.limit) && options.limit! > 0 ? Math.min(options.limit!, 1000) : null;
  const params: any[] = [];
  const where: string[] = ['(s.archived IS NULL OR s.archived = 0)'];
  let accessibleIds: string[] | null = null;

  if (userId) {
    // Treat missing/legacy JWT role as ordinary member, not as "no auth". The
    // old `userId && role` guard made role-less tokens fall through to the
    // admin/no-auth full list, leaking session titles and owners in the sidebar.
    accessibleIds = await getAccessibleProjectIds(userId, role || 'member');
    if (accessibleIds !== null) {
      params.push(accessibleIds);
      const projectIdsParam = `$${params.length}::text[]`;
      params.push(userId);
      const userIdParam = `$${params.length}`;
      where.push(`(
        (s.user_id IS NULL AND ((s.project_id IS NULL AND s.label = 'channel_ai') OR s.project_id = ANY(${projectIdsParam})))
        OR
        (s.user_id IS NOT NULL AND (
          (s.project_id IS NULL AND s.user_id = ${userIdParam})
          OR
          (s.project_id = ANY(${projectIdsParam}) AND (s.user_id = ${userIdParam} OR s.visibility = 'project'))
        ))
      )`);
    }
  }

  if (options.projectId) {
    params.push(options.projectId);
    where.push(`s.project_id = $${params.length}`);
  }

  if (options.sidebarOnly) {
    where.push(`(s.parent_session_id IS NULL OR s.label IN ('spawned', 'agent', 'conversation_branch'))`);
    where.push(`(s.room_id IS NULL OR s.label = 'channel_ai')`);
  }

  const limitClause = limit ? `LIMIT $${params.push(limit)}` : '';

  // Pick the visible recent session window first, then compute message-derived
  // metadata only for those rows. The old shape grouped the entire messages
  // table before LIMIT, so /sessions?limit=200 could still spend seconds on
  // historical sessions the frontend never received.
  const rows = await query(`
    WITH visible_sessions AS (
      SELECT s.*
      FROM sessions s
      WHERE ${where.join('\n        AND ')}
      ORDER BY s.updated_at DESC
      ${limitClause}
    )
    SELECT s.*,
           u.username AS owner_username,
           lum.username AS last_user_username,
           COALESCE(utc.cnt, 0)::int AS user_turn_count,
           aw.id AS agent_worker_id,
           aw.name AS agent_worker_name,
           aw.role AS agent_worker_role,
           aw.visibility AS agent_worker_visibility,
           aw.status AS agent_worker_status,
           aw.kind AS agent_worker_kind,
           COALESCE((aw.metadata->>'humanTouched')::boolean, htc.cnt > 0, false) AS agent_worker_human_touched
    FROM visible_sessions s
    LEFT JOIN users u ON s.user_id = u.id
    LEFT JOIN agent_workers aw ON aw.backing_session_id = s.id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS cnt
      FROM messages m
      WHERE m.session_id = s.id
        AND m.role = 'user'
        AND m.content LIKE '[{"type":"text"%'
    ) utc ON true
    LEFT JOIN LATERAL (
      SELECT m.username
      FROM messages m
      WHERE m.session_id = s.id
        AND ${humanTouchedSql('m')}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1
    ) lum ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS cnt
      FROM messages m
      WHERE m.session_id = s.id
        AND ${humanTouchedSql('m')}
    ) htc ON true
    ORDER BY s.updated_at DESC
  `, params) as any[];

  const favs = await getUserFavoriteSessionIds(userId);

  if (userId && accessibleIds === null) {
    return rows
      .filter(r => isSessionListVisibleToUser(r, userId, accessibleIds))
      .map(r => mapRow(r, favs));
  }

  return rows.map(r => mapRow(r, favs));
}

/**
 * Convert a `sessions` row to SessionMeta.
 *
 * `favoriteSet` is the *caller's* favorite session IDs (from
 * user_session_favorites). When omitted, favorite defaults to false — used by
 * system code paths that have no user context. The legacy `row.favorite` column
 * is intentionally ignored.
 * 결정: workspace/decisions/2026-05-22-per-user-session-favorites.md
 */
function mapRow(row: any, favoriteSet?: Set<string>): SessionMeta {
  return {
    id: row.id,
    shortCode: row.short_code || undefined,
    claudeSessionId: row.claude_session_id || undefined,
    piSessionFile: row.pi_session_file || undefined,
    engineSessionId: row.engine === 'pi'
      ? row.pi_session_file || undefined
      : row.engine === 'claude'
        ? row.claude_session_id || undefined
        : undefined,
    name: row.name,
    cwd: row.cwd,
    tags: JSON.parse(row.tags || '[]'),
    favorite: favoriteSet ? favoriteSet.has(row.id) : false,
    totalCost: row.total_cost,
    totalTokens: row.total_tokens,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    modelUsed: row.model_used || undefined,
    autoNamed: row.auto_named ?? 1,
    summary: row.summary || undefined,
    summaryAtTurn: row.summary_at_turn ?? undefined,
    turnCount: row.turn_count ?? 0,
    userTurnCount: row.user_turn_count ?? 0,
    filesEdited: JSON.parse(row.files_edited || '[]'),
    projectId: row.project_id || null,
    engine: row.engine || config.defaultEngine || 'pi',
    visibility: row.visibility || 'private',
    roomId: row.room_id || null,
    parentSessionId: row.parent_session_id || null,
    sourceMessageId: row.source_message_id || null,
    ownerUsername: row.owner_username || null,
    lastUserUsername: row.last_user_username || null,
    label: normalizeSessionDeckLabel(row.label),
    agentCreationCommandId: row.agent_creation_command_id || null,
    agent: row.agent_worker_id ? {
      workerId: row.agent_worker_id,
      name: row.agent_worker_name,
      role: row.agent_worker_role || null,
      visibility: row.agent_worker_visibility || null,
      status: row.agent_worker_status || null,
      kind: row.agent_worker_kind || null,
      hasHumanInput: row.agent_worker_human_touched === true,
    } : null,
    kind: row.kind === 'autonomous_run' ? 'autonomous_run' : row.kind === 'deployment' ? 'deployment' : 'user',
    configDir: row.config_dir || null,
    lastAutoResumeAt: row.last_auto_resume_at
      ? (row.last_auto_resume_at instanceof Date ? row.last_auto_resume_at.toISOString() : String(row.last_auto_resume_at))
      : null,
  };
}

/**
 * Fetch one session.
 *
 * `userId` is optional but recommended — without it, `favorite` is always
 * false. Pass the caller's userId so the returned `SessionMeta.favorite`
 * reflects *that* user's bookmark, matching what they see in the sidebar.
 * 결정: workspace/decisions/2026-05-22-per-user-session-favorites.md
 */
export async function getSession(id: string, userId?: number): Promise<SessionMeta | null> {
  const row = await queryOne(`
    SELECT s.*,
           u.username AS owner_username,
           aw.id AS agent_worker_id,
           aw.name AS agent_worker_name,
           aw.role AS agent_worker_role,
           aw.visibility AS agent_worker_visibility,
           aw.status AS agent_worker_status,
           aw.kind AS agent_worker_kind,
           COALESCE((aw.metadata->>'humanTouched')::boolean, htc.cnt > 0, false) AS agent_worker_human_touched
      FROM sessions s
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN agent_workers aw ON aw.backing_session_id = s.id
      LEFT JOIN (
        SELECT session_id, COUNT(*) AS cnt
        FROM messages m
        WHERE ${humanTouchedSql('m')}
        GROUP BY session_id
      ) htc ON htc.session_id = s.id
     WHERE s.id = $1
  `, [id]) as any;
  if (!row) return null;
  const favs = await getUserFavoriteSessionIds(userId);
  return mapRow(row, favs);
}

/**
 * Stamp `last_auto_resume_at = NOW()` on a session.
 *
 * Called by `serverSideResumeInterrupted()` (ws-handler.ts) when it injects
 * a hidden trigger message after a backend restart. Kept separate from
 * `updateSession()` so it does NOT bump `updated_at` (otherwise the sidebar
 * re-shuffles on every server restart, which is misleading — the user
 * didn't actually do anything).
 *
 * See: workspace/decisions/2026-05-10-server-resume-prompt-hidden.md
 */
export async function setLastAutoResumeAt(id: string): Promise<void> {
  await execute(
    'UPDATE sessions SET last_auto_resume_at = CURRENT_TIMESTAMP WHERE id = $1',
    [id]
  );
}

export async function deleteSession(id: string): Promise<boolean> {
  // Hide/archive: remove from the default sidebar list, preserve data for History restore.
  // Permanent deletion is intentionally separate: DELETE /api/sessions/:id/permanent.
  const result = await execute('UPDATE sessions SET archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
  return result.changes > 0;
}

export async function getArchivedSessions(userId?: number, role?: string): Promise<SessionMeta[]> {
  // History lives under "내 작업", so authenticated users should see their own
  // archived sessions rather than every project-visible session in the workspace.
  // Scope in SQL first to avoid joining/aggregating every archived row before
  // JS filtering. Admin/operator global audit views should use a separate
  // explicit endpoint/UI.
  const ownHistoryClause = userId ? 'AND s.user_id = $1' : '';
  const rows = await query(`
    SELECT s.*,
           u.username AS owner_username,
           aw.id AS agent_worker_id,
           aw.name AS agent_worker_name,
           aw.role AS agent_worker_role,
           aw.visibility AS agent_worker_visibility,
           aw.status AS agent_worker_status,
           aw.kind AS agent_worker_kind,
           COALESCE((aw.metadata->>'humanTouched')::boolean, htc.cnt > 0, false) AS agent_worker_human_touched
      FROM sessions s
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN agent_workers aw ON aw.backing_session_id = s.id
      LEFT JOIN (
        SELECT session_id, COUNT(*) AS cnt
        FROM messages m
        WHERE ${humanTouchedSql('m')}
        GROUP BY session_id
      ) htc ON htc.session_id = s.id
     WHERE s.archived = 1
       ${ownHistoryClause}
     ORDER BY s.updated_at DESC
  `, userId ? [userId] : []) as any[];

  const favs = await getUserFavoriteSessionIds(userId);

  if (userId) {
    const accessibleIds = await getAccessibleProjectIds(userId, role || 'member');
    return rows
      .filter(r => isSessionListVisibleToUser(r, userId, accessibleIds))
      .map(r => mapRow(r, favs));
  }

  // No auth/dev mode: return all (backward compat)
  return rows.map(r => mapRow(r, favs));
}

export async function restoreSession(id: string): Promise<boolean> {
  const result = await execute('UPDATE sessions SET archived = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
  return result.changes > 0;
}

export async function permanentlyDeleteSession(id: string): Promise<boolean> {
  const result = await execute('DELETE FROM sessions WHERE id = $1', [id]);
  return result.changes > 0;
}

/**
 * Clone a session — produce an independent copy with the same context up to "now".
 *
 * What's copied:
 *   1. sessions row (new id, new engine-specific resume id, name + ' (복제)')
 *   2. messages rows (each with a new uuid; session_id rewired)
 *   3. native resume file (.pi session for Pi, Claude .jsonl for Claude)
 *
 * Returns the new SessionMeta on success.
 *
 * Errors:
 *   - 'NOT_FOUND'         — source session does not exist
 *   - 'IN_PROGRESS'       — source session has an in-flight SDK turn (its .jsonl tail
 *                           is mid-write; copying now would corrupt the new session)
 *
 * Note: callers (route handler) are responsible for permission checks via
 *       canAccessSession before invoking this function. The clone's owner becomes
 *       the supplied `actorUserId`; visibility is forced to 'private' so a clone of
 *       another user's project-shared session does not auto-republish.
 */
export async function cloneSession(
  sourceId: string,
  actorUserId: number | null,
): Promise<SessionMeta> {
  // 1. Read source session metadata
  const src = await queryOne<any>('SELECT * FROM sessions WHERE id = $1', [sourceId]);
  if (!src) throw new Error('NOT_FOUND');

  // 2. Refuse to clone while the source has an in-flight SDK turn — its .jsonl
  //    tail may be a half-written line, and copying mid-stream would poison the
  //    clone. We rely on the engines' in-memory running-session set rather than
  //    a jsonl-tail heuristic: the SDK doesn't write a stable end-of-turn marker,
  //    so a heuristic flagged every session as "in progress".
  if (getAllRunningSessionIds().includes(sourceId)) {
    throw new Error('IN_PROGRESS');
  }

  // 3. Mint new IDs
  const newId = uuidv4();
  const sourceEngine = src.engine || config.defaultEngine || 'pi';
  const isPiSource = sourceEngine === 'pi';
  const newClaudeSessionId = !isPiSource && src.claude_session_id ? uuidv4() : null;
  const newName = `${src.name} (복제)`;

  // 4. Insert new sessions row — copy almost everything, override identity + audit fields.
  //    config_dir inherits from src so the cloned .jsonl (copied in step 6) lives in
  //    the same configDir as the source — even if src.project_id's account is later
  //    reassigned. This decouples session-level jsonl location from the mutable
  //    project→account binding.
  // INSERT with short_code retry — clone 도 새 short_code 발급 (issue #11 Phase 2).
  for (let attempt = 0; attempt < SHORT_CODE_MAX_RETRIES; attempt++) {
    const cloneShortCode = generateShortCode();
    try {
      await execute(
        `INSERT INTO sessions (
           id, short_code, claude_session_id, name, cwd, tags, favorite, user_id,
           total_cost, total_tokens, model_used, auto_named, summary,
           summary_at_turn, turn_count, files_edited, archived, engine,
           visibility, room_id, project_id, source_message_id, parent_session_id, label,
           config_dir, pi_session_file
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12, $13,
           $14, $15, $16, 0, $17,
           $18, $19, $20, $21, $22, $23,
           $24, $25
         )`,
        [
          newId, cloneShortCode, newClaudeSessionId, newName, src.cwd, src.tags || '[]', 0, actorUserId,
          src.total_cost ?? 0, src.total_tokens ?? 0, src.model_used, src.auto_named ?? 1, src.summary,
          src.summary_at_turn, src.turn_count ?? 0, src.files_edited || '[]', sourceEngine,
          'private', src.room_id, src.project_id, src.source_message_id, src.parent_session_id, src.label,
          src.config_dir, null,
        ],
      );
      break;
    } catch (err: any) {
      if (err?.code === PG_UNIQUE_VIOLATION && attempt < SHORT_CODE_MAX_RETRIES - 1) {
        continue;
      }
      throw err;
    }
  }

  // 5. Copy the active conversation — each message gets a fresh uuid and the
  //    session_id is rewired. Preserve metadata + message_seq because metadata
  //    controls message visibility/rendering and message_seq is the durable
  //    conversation ordering authority. Omitting either can revive superseded
  //    turns or scramble cloned model context when timestamps tie.
  //
  //    short_id is intentionally not copied. The next backfill assigns fresh
  //    per-session ids without colliding with the source session.
  await execute(
    `INSERT INTO messages (id, session_id, role, content, parent_tool_use_id,
                           duration_ms, input_tokens, output_tokens, created_at, username,
                           metadata, message_seq)
     SELECT gen_random_uuid()::text, $1, role, content, parent_tool_use_id,
            duration_ms, input_tokens, output_tokens, created_at, username,
            metadata, message_seq
       FROM messages
      WHERE session_id = $2
        AND COALESCE(metadata->>'contextState', 'active') = 'active'
      ORDER BY message_seq ASC`,
    [newId, sourceId],
  );

  // 6. Pin/copy the immutable Harness runtime snapshot for Pi clones BEFORE
  //    creating a native resume file. PiEngine requires a pinned snapshot when
  //    resuming an existing pi_session_file. Without this, a cloned Session can
  //    show all copied DB messages but fail on the first follow-up with:
  //    "Pinned Harness snapshot is required to resume Session ...".
  //
  //    Prefer exact snapshot copy from the source so a clone preserves the
  //    original runtime contract. If the source is an older Session without a
  //    snapshot, fall back to getOrPinSessionHarnessSnapshot for the clone. If
  //    both fail, skip native rehydrate so the next turn starts fresh and can
  //    retry lazy pinning instead of creating an unresumable pi_session_file.
  let piHarnessSnapshotReady = !isPiSource;
  if (isPiSource) {
    try {
      await execute(
        `INSERT INTO session_runtime_snapshots (
           session_id, project_id, harness_id, harness_version, runtime_profile_id,
           runtime_profile_version, engine, snapshot, snapshot_hash, source, pinned_at,
           prompt_bundle_hash
         )
         SELECT $1, project_id, harness_id, harness_version, runtime_profile_id,
                runtime_profile_version, engine, snapshot, snapshot_hash, source, now(),
                prompt_bundle_hash
           FROM session_runtime_snapshots
          WHERE session_id = $2
         ON CONFLICT (session_id) DO NOTHING`,
        [newId, sourceId],
      );
      const { getOrPinSessionHarnessSnapshot } = await import('../harness/harness-store.js');
      await getOrPinSessionHarnessSnapshot({
        sessionId: newId,
        projectId: src.project_id || undefined,
        requestedEngine: 'pi',
        requestedModel: src.model_used || undefined,
        invocationKind: 'session',
      });
      piHarnessSnapshotReady = true;
    } catch (err) {
      console.warn('[session-manager] clone: Harness snapshot copy/pin failed; native Pi rehydrate will be skipped:', err);
    }
  }

  // 7. Create/copy the native resume file (best-effort — log on failure but don't roll back).
  if (isPiSource) {
    if (!piHarnessSnapshotReady) {
      console.warn(`[session-manager] clone: skipping Pi session rehydrate for ${newId} because Harness snapshot is unavailable`);
    } else try {
      const rows = await query<any>(
        `SELECT id, role, content, created_at, metadata
           FROM messages
          WHERE session_id = $1
            AND role IN ('user', 'assistant')
            AND COALESCE(metadata->>'hidden', '') = ''
            AND NOT (metadata ? 'engineSwitch')
          ORDER BY message_seq ASC`,
        [newId],
      );
      const rehydrateInput: RehydrateInputMessage[] = [];
      for (const row of rows) {
        let content: any;
        try {
          content = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
        } catch {
          continue;
        }
        if (!Array.isArray(content)) continue;
        rehydrateInput.push({
          id: row.id,
          role: row.role,
          content,
          timestamp: row.created_at ? new Date(row.created_at).getTime() : undefined,
        });
      }
      if (rehydrateInput.length > 0) {
        const piSessionFile = await rehydratePiSessionFromMessages(newId, rehydrateInput, src.cwd);
        await execute('UPDATE sessions SET pi_session_file = $1 WHERE id = $2', [piSessionFile, newId]);
      }
    } catch (err) {
      console.warn('[session-manager] clone: Pi session rehydrate failed:', err);
      // Don't roll back — DB-level clone is still useful; Pi will start a fresh
      // session file on next turn. User loses raw model history but keeps DB-rendered view.
    }
  } else if (src.claude_session_id && newClaudeSessionId) {
    try {
      // Prefer the row's pinned config_dir (set at create time, stable across
      // project→account reassignment). Fall back to runtime resolution for
      // older rows where backfill couldn't determine an account.
      const cfgDir = src.config_dir ?? (await getConfigDir(src.project_id)) ?? null;
      const srcJsonl = findJsonlFileForSession({
        cwd: src.cwd,
        claude_session_id: src.claude_session_id,
        config_dir: cfgDir,
      });
      if (srcJsonl) {
        const dstJsonl = path.join(path.dirname(srcJsonl), `${newClaudeSessionId}.jsonl`);
        fs.copyFileSync(srcJsonl, dstJsonl);
      } else {
        console.warn(`[session-manager] clone: source .jsonl not found for ${src.claude_session_id} (cfgDir=${cfgDir || 'default'})`);
      }
    } catch (err) {
      console.warn('[session-manager] clone: .jsonl copy failed:', err);
      // Don't roll back — DB-level clone is still useful; SDK will start a fresh
      // .jsonl on next turn. User loses raw history but keeps DB-rendered view.
    }
  }

  // 7. Resolve owner username for the returned SessionMeta
  let ownerUsername: string | null = null;
  if (actorUserId) {
    const userRow = await queryOne<{ username: string }>(
      'SELECT username FROM users WHERE id = $1',
      [actorUserId],
    );
    ownerUsername = userRow?.username ?? null;
  }

  // 8. Return SessionMeta — re-fetch so timestamps/aggregates are accurate
  const fresh = await queryOne<any>('SELECT * FROM sessions WHERE id = $1', [newId]);
  return mapRow({ ...fresh, owner_username: ownerUsername });
}


/**
 * Startup audit: log sessions whose .jsonl files are missing.
 * We intentionally do NOT clear claude_session_id — clearing it causes permanent context loss
 * (every subsequent turn silently starts a fresh SDK session with no memory).
 * Instead, sdk.ts will throw an explicit error on resume, telling the user to start a new session.
 */
export async function auditStaleSessions(): Promise<number> {
  // Multi-account aware: include config_dir so the per-row jsonl lookup
  // searches the correct account directory. Before PR-1/PR-2 this scanned
  // ~/.claude/ only and reported every gmail-account session as stale.
  const rows = await query(
    `SELECT id, claude_session_id, cwd, config_dir FROM sessions
     WHERE claude_session_id IS NOT NULL AND claude_session_id != ''
       AND (archived IS NULL OR archived = 0)`
  ) as { id: string; claude_session_id: string; cwd: string; config_dir: string | null }[];

  let stale = 0;
  for (const row of rows) {
    const found = findJsonlFileForSession(row);
    if (!found) stale++;
  }

  if (stale > 0) {
    console.log(`[session-manager] ${stale} session(s) have missing .jsonl files (will fail on resume with explicit error)`);
  }
  return stale;
}

/**
 * Scan Claude native session files across **all registered accounts** (PR-4,
 * 2026-05-09). Previously this scanned only ~/.claude/projects/, which made
 * non-default-account jsonl invisible from the admin debug endpoint
 * (/api/claude-sessions). Multi-account installs (e.g. ~/.claude-gmail/)
 * were therefore underreported by ~95% on this server.
 *
 * Each returned row carries `configDir` so the caller can tell which
 * account a given jsonl belongs to.
 */
export async function scanClaudeNativeSessions(): Promise<{
  sessionId: string;
  projectPath: string;
  modified: string;
  configDir: string;
}[]> {
  // Always include ~/.claude/ as the implicit default even when not in
  // claude_accounts (legacy / single-account installs). Plus all enabled
  // accounts. Set deduplicates if claude_accounts already lists it.
  const accountRows = await query(
    'SELECT config_dir FROM claude_accounts WHERE enabled = true',
  ) as { config_dir: string }[];
  const candidateDirs = new Set<string>([path.join(os.homedir(), '.claude')]);
  for (const r of accountRows) candidateDirs.add(r.config_dir);

  const sessions: {
    sessionId: string;
    projectPath: string;
    modified: string;
    configDir: string;
  }[] = [];

  for (const cfgDir of candidateDirs) {
    const projectsDir = path.join(cfgDir, 'projects');
    if (!fs.existsSync(projectsDir)) continue;

    try {
      const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue;
        const projectPath = path.join(projectsDir, dir.name);
        const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          const filePath = path.join(projectPath, file);
          const stat = fs.statSync(filePath);
          sessions.push({
            sessionId: file.replace('.jsonl', ''),
            projectPath: dir.name,
            modified: stat.mtime.toISOString(),
            configDir: cfgDir,
          });
        }
      }
    } catch { /* per-cfgDir scan failure is non-fatal */ }
  }

  return sessions.sort((a, b) => b.modified.localeCompare(a.modified));
}

// ═══════════════════════════════════════════════════════════════════
// Engine switch history
// ───────────────────────────────────────────────────────────────────
// See: workspace/decisions/2026-05-19-engine-hard-switch-design.md
// Hard switch flow (Phase 1.1 — db side only; rehydrate + API land later):
//   1. ws-handler / API verifies session is idle + no pending tool_use
//   2. new engine.rehydrateFromMessages() builds its native session file
//   3. caller invokes recordEngineSwitch() — updates sessions row +
//      appends an immutable audit row to session_engine_history
// ═══════════════════════════════════════════════════════════════════

export interface EngineSwitchRecord {
  id: number;
  sessionId: string;
  fromEngine: string | null;
  toEngine: string;
  atTurn: number;
  atMessageId: string | null;
  reason: string | null;
  fromSessionId: string | null;
  toSessionId: string | null;
  switchedAt: string;
  switchedBy: number | null;
}

export interface RecordEngineSwitchInput {
  sessionId: string;
  fromEngine: string;
  toEngine: string;
  /** sessions.turn_count snapshot at switch time */
  atTurn: number;
  /** First message under the new engine, if already known */
  atMessageId?: string | null;
  reason?: string;
  /** Previous engine's session identifier (e.g. claude_session_id value being parked) */
  fromSessionId?: string | null;
  /** New engine's session identifier (e.g. pi_session_file path) */
  toSessionId?: string | null;
  switchedBy?: number | null;
}

/**
 * Atomically swap a session's engine and append an immutable history row.
 *
 * Invariants:
 *   - Does NOT verify "session is idle" or "no pending tool_use" — that's the
 *     caller's job (ws-handler / API guard).  This function trusts its caller.
 *   - Does NOT touch claude_session_id / pi_session_file — those live on the
 *     session row directly and should be updated via updateSession() either
 *     before or after this call.  We record their values in history for audit
 *     but don't move them around (clearing a previous engine's resume id
 *     would destroy archival value).
 *   - Bumps updated_at because the engine change IS a real activity event,
 *     even if no chat turn happened — sidebar should re-order.
 */
export async function recordEngineSwitch(input: RecordEngineSwitchInput): Promise<EngineSwitchRecord> {
  const { sessionId, fromEngine, toEngine, atTurn, atMessageId, reason, fromSessionId, toSessionId, switchedBy } = input;

  // Same-engine guard — caller bug, fail loudly.
  if (fromEngine === toEngine) {
    throw new Error(`recordEngineSwitch: from_engine and to_engine are both '${toEngine}' (no-op).`);
  }

  // Update sessions row first so a concurrent reader can't see history saying
  // "switched to pi" while sessions.engine still reads 'claude'.
  await execute(
    `UPDATE sessions SET engine = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [toEngine, sessionId]
  );

  const row = await queryOne<any>(
    `INSERT INTO session_engine_history
       (session_id, from_engine, to_engine, at_turn, at_message_id, reason, from_session_id, to_session_id, switched_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [sessionId, fromEngine, toEngine, atTurn, atMessageId ?? null, reason ?? null, fromSessionId ?? null, toSessionId ?? null, switchedBy ?? null]
  );

  if (!row) {
    // INSERT … RETURNING should always come back; guard anyway.
    throw new Error(`recordEngineSwitch: INSERT returned no row for session ${sessionId}`);
  }

  return mapEngineSwitchRow(row);
}

/** Newest-first; the create-anchor row (from_engine IS NULL) is always last. */
export async function getEngineSwitchHistory(sessionId: string): Promise<EngineSwitchRecord[]> {
  const rows = await query<any>(
    `SELECT * FROM session_engine_history WHERE session_id = $1 ORDER BY switched_at DESC, id DESC`,
    [sessionId]
  );
  return rows.map(mapEngineSwitchRow);
}

function mapEngineSwitchRow(row: any): EngineSwitchRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    fromEngine: row.from_engine ?? null,
    toEngine: row.to_engine,
    atTurn: row.at_turn ?? 0,
    atMessageId: row.at_message_id ?? null,
    reason: row.reason ?? null,
    fromSessionId: row.from_session_id ?? null,
    toSessionId: row.to_session_id ?? null,
    switchedAt: row.switched_at instanceof Date ? row.switched_at.toISOString() : String(row.switched_at),
    switchedBy: row.switched_by ?? null,
  };
}

// ── Phase 2 short_code helpers ─────────────────────────────────────────────
// 결정: workspace/decisions/2026-05-24-url-routing-phase-2-short-code.md

/**
 * URL key (short_code or UUID) 로 세션 1건 조회. Phase 1.3 이후 routes/api.ts 의
 * `/api/sessions/:id` 가 이 함수를 쓰도록 옮기면 옛 UUID 링크와 새 short_code 링크
 * 둘 다 자동 호환. 현재는 frontend deep-link 가 sessions 목록에서 직접 매칭하므로
 * 이 함수는 *옵션* (외부에서 호출하는 케이스만).
 */
export async function getSessionByKey(key: string, userId?: number): Promise<SessionMeta | null> {
  // key 형태로 분기 — short_code 는 영문 소문자+숫자 8자, UUID 는 36자 with '-'
  const isUuidLike = key.length === 36 && key.includes('-');
  const sql = isUuidLike
    ? 'SELECT * FROM sessions WHERE id = $1'
    : 'SELECT * FROM sessions WHERE short_code = $1';
  const row = await queryOne(sql, [key]) as any;
  if (!row) return null;
  const favs = await getUserFavoriteSessionIds(userId);
  return mapRow(row, favs);
}

/**
 * 부팅 시 일괄 backfill — short_code 가 NULL 인 모든 세션에 발급.
 * 단일 진실(생성 로직 TS 한 곳) + 결정적. backend/index.ts 의 initPg() 직후 fire-and-forget.
 * 수천 세션 = 한 자리 초.
 *
 * 반환: 업데이트한 행 수.
 */
export async function backfillSessionShortCodes(): Promise<number> {
  const rows = await query<{ id: string }>('SELECT id FROM sessions WHERE short_code IS NULL', []);
  if (rows.length === 0) return 0;
  let updated = 0;
  for (const row of rows) {
    for (let attempt = 0; attempt < SHORT_CODE_MAX_RETRIES; attempt++) {
      const code = generateShortCode();
      try {
        await execute(
          'UPDATE sessions SET short_code = $1 WHERE id = $2 AND short_code IS NULL',
          [code, row.id],
        );
        // 다른 인스턴스가 동시에 채워서 rowCount=0 일 수도 — 그 경우도 OK (NULL → 값 으로 바뀐 건 사실)
        updated++;
        break;
      } catch (err: any) {
        if (err?.code === PG_UNIQUE_VIOLATION && attempt < SHORT_CODE_MAX_RETRIES - 1) {
          continue;
        }
        // 다른 에러는 로그만 + 다음 행 — 부팅을 멈추지 않음
        console.warn(`[session-manager] backfillShortCodes: row ${row.id} failed:`, err?.message);
        break;
      }
    }
  }
  return updated;
}
