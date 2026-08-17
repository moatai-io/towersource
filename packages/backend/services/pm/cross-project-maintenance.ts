// Owns explicit admin/operator cross-project maintenance grants.
// Public API: create/list/revoke active grants and resolve tool-guard input.
// See: workspace/decisions/2026-06-21-cross-project-continuation-and-maintenance.md

import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { execute, query, queryOne } from '../../db/pg-repo.js';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(process.env.HOME || '/tmp', 'workspace');

export type MaintenanceGrantScope = 'selected_projects' | 'all_projects';
export type MaintenanceGrantMode = 'dry_run' | 'apply';
export type MaintenanceGrantStatus = 'active' | 'used' | 'expired' | 'revoked';

export interface CrossProjectMaintenanceGrantRow {
  id: string;
  actor_user_id: number;
  source_session_id: string | null;
  reason: string;
  scope_type: MaintenanceGrantScope;
  project_ids: string[];
  allowed_paths: string[];
  mode: MaintenanceGrantMode;
  status: MaintenanceGrantStatus;
  expires_at: Date | string;
  created_at: Date | string;
  used_at?: Date | string | null;
  metadata?: any;
}

export interface MaintenanceToolGrant {
  id: string;
  mode: MaintenanceGrantMode;
  projectRoots: string[];
  allowedPaths: string[];
}

const DEFAULT_ALLOWED_PATHS = ['AGENTS.md', '.project/**', '.tower/skills/**', 'skills/**'];

function normalizeAllowedPaths(pathsInput: unknown): string[] {
  const raw = Array.isArray(pathsInput) ? pathsInput : DEFAULT_ALLOWED_PATHS;
  const cleaned = raw
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.trim().replace(/^\/+/, ''))
    .filter(Boolean)
    .filter((p) => !p.includes('..'));
  return cleaned.length > 0 ? Array.from(new Set(cleaned)) : DEFAULT_ALLOWED_PATHS;
}

function normalizeProjectIds(projectIdsInput: unknown): string[] {
  if (!Array.isArray(projectIdsInput)) return [];
  return Array.from(new Set(projectIdsInput.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim())));
}

function rowToGrant(row: any): CrossProjectMaintenanceGrantRow {
  return {
    id: row.id,
    actor_user_id: Number(row.actor_user_id),
    source_session_id: row.source_session_id ?? null,
    reason: row.reason,
    scope_type: row.scope_type,
    project_ids: Array.isArray(row.project_ids) ? row.project_ids : [],
    allowed_paths: Array.isArray(row.allowed_paths) ? row.allowed_paths : [],
    mode: row.mode,
    status: row.status,
    expires_at: row.expires_at,
    created_at: row.created_at,
    used_at: row.used_at ?? null,
    metadata: row.metadata ?? {},
  };
}

export async function createCrossProjectMaintenanceGrant(input: {
  actorUserId: number;
  sourceSessionId?: string | null;
  reason: string;
  scopeType?: MaintenanceGrantScope;
  projectIds?: unknown;
  allowedPaths?: unknown;
  mode?: MaintenanceGrantMode;
  ttlMinutes?: number;
  metadata?: any;
}): Promise<CrossProjectMaintenanceGrantRow> {
  const id = uuidv4();
  const scopeType = input.scopeType === 'all_projects' ? 'all_projects' : 'selected_projects';
  const projectIds = normalizeProjectIds(input.projectIds);
  if (scopeType === 'selected_projects' && projectIds.length === 0) {
    throw new Error('selected_projects grant requires at least one projectId');
  }
  const allowedPaths = normalizeAllowedPaths(input.allowedPaths);
  const mode: MaintenanceGrantMode = input.mode === 'apply' ? 'apply' : 'dry_run';
  const ttl = Math.max(1, Math.min(24 * 60, Number(input.ttlMinutes || 60)));
  const reason = String(input.reason || '').trim();
  if (!reason) throw new Error('reason required');

  const row = await queryOne<any>(
    `INSERT INTO cross_project_maintenance_grants
       (id, actor_user_id, source_session_id, reason, scope_type, project_ids, allowed_paths, mode, expires_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, now() + ($9::text || ' minutes')::interval, $10::jsonb)
     RETURNING *`,
    [
      id,
      input.actorUserId,
      input.sourceSessionId || null,
      reason,
      scopeType,
      JSON.stringify(projectIds),
      JSON.stringify(allowedPaths),
      mode,
      String(ttl),
      JSON.stringify(input.metadata || {}),
    ],
  );
  if (!row) throw new Error('failed to create maintenance grant');
  return rowToGrant(row);
}

export async function listCrossProjectMaintenanceGrants(input: {
  actorUserId?: number;
  sourceSessionId?: string;
  includeInactive?: boolean;
  limit?: number;
} = {}): Promise<CrossProjectMaintenanceGrantRow[]> {
  const where: string[] = [];
  const params: any[] = [];
  if (input.actorUserId) {
    params.push(input.actorUserId);
    where.push(`actor_user_id = $${params.length}`);
  }
  if (input.sourceSessionId) {
    params.push(input.sourceSessionId);
    where.push(`source_session_id = $${params.length}`);
  }
  if (!input.includeInactive) {
    where.push(`status = 'active' AND expires_at > now()`);
  }
  const limit = Math.max(1, Math.min(200, Number(input.limit || 50)));
  const rows = await query<any>(
    `SELECT * FROM cross_project_maintenance_grants
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map(rowToGrant);
}

export async function revokeCrossProjectMaintenanceGrant(id: string, actorUserId: number): Promise<boolean> {
  const result = await execute(
    `UPDATE cross_project_maintenance_grants
        SET status = 'revoked'
      WHERE id = $1 AND actor_user_id = $2 AND status = 'active'`,
    [id, actorUserId],
  );
  return result.changes > 0;
}

export async function resolveActiveMaintenanceToolGrant(input: {
  actorUserId: number;
  sourceSessionId: string;
}): Promise<MaintenanceToolGrant | null> {
  const grant = await queryOne<any>(
    `SELECT * FROM cross_project_maintenance_grants
      WHERE actor_user_id = $1
        AND source_session_id = $2
        AND status = 'active'
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1`,
    [input.actorUserId, input.sourceSessionId],
  );
  if (!grant) return null;

  const ids = Array.isArray(grant.project_ids) ? grant.project_ids : [];
  const params: any[] = [];
  let sql = `SELECT root_path FROM projects WHERE root_path IS NOT NULL AND (archived IS NULL OR archived = 0)`;
  if (grant.scope_type !== 'all_projects') {
    params.push(ids);
    sql += ` AND id = ANY($1::text[])`;
  }
  const roots = await query<{ root_path: string }>(sql, params);
  return {
    id: grant.id,
    mode: grant.mode,
    projectRoots: roots.map((r) => path.resolve(r.root_path)).filter((p) => p.startsWith(path.resolve(WORKSPACE_ROOT) + path.sep)),
    allowedPaths: normalizeAllowedPaths(grant.allowed_paths),
  };
}

export async function recordCrossProjectMaintenanceEvent(input: {
  grantId?: string | null;
  actorUserId?: number | null;
  sessionId?: string | null;
  projectId?: string | null;
  filePath?: string | null;
  action: string;
  outcome?: 'ok' | 'error' | 'denied';
  diffSummary?: string | null;
  metadata?: any;
}): Promise<void> {
  await execute(
    `INSERT INTO cross_project_maintenance_events
       (grant_id, actor_user_id, session_id, project_id, file_path, action, outcome, diff_summary, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      input.grantId || null,
      input.actorUserId || null,
      input.sessionId || null,
      input.projectId || null,
      input.filePath || null,
      input.action,
      input.outcome || 'ok',
      input.diffSummary || null,
      JSON.stringify(input.metadata || {}),
    ],
  );
}
