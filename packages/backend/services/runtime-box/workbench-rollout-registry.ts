/**
 * Owns: Restart-free Project rollout state for the Agent Workbench beta.
 * Public API: resolveWorkbenchRollout, listWorkbenchRollouts, setWorkbenchRollout.
 *
 * PostgreSQL is authoritative for explicit Project overrides. The legacy env
 * allowlist remains a compatibility fallback until existing beta Projects are
 * migrated. A disabled DB row always overrides that fallback.
 */

import { config } from '../../config.js';
import { query, queryOne } from '../../db/pg-repo.js';

export type WorkbenchRolloutStatus = 'enabled' | 'disabled' | 'observe';

export interface WorkbenchRolloutRow {
  project_id: string;
  project_name?: string | null;
  status: WorkbenchRolloutStatus;
  cohort: string | null;
  reason: string | null;
  config_json: Record<string, unknown>;
  updated_by_user_id: number | null;
  enabled_at: Date | string | null;
  disabled_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ResolvedWorkbenchRollout {
  enabled: boolean;
  status: WorkbenchRolloutStatus;
  source: 'database' | 'legacy-env' | 'default';
  cohort: string | null;
}

/** Resolve one Project with explicit DB state taking precedence over legacy env. */
export async function resolveWorkbenchRollout(projectId: string): Promise<ResolvedWorkbenchRollout> {
  const row = await queryOne<Pick<WorkbenchRolloutRow, 'status' | 'cohort'>>(
    'SELECT status, cohort FROM runtime_box_workbench_rollouts WHERE project_id=$1',
    [projectId],
  );
  if (row) {
    return {
      enabled: row.status === 'enabled',
      status: row.status,
      source: 'database',
      cohort: row.cohort ?? null,
    };
  }
  if (config.experimentalWorkbenchTools.projectIds.includes(projectId)) {
    return { enabled: true, status: 'enabled', source: 'legacy-env', cohort: 'legacy-env' };
  }
  return { enabled: false, status: 'disabled', source: 'default', cohort: null };
}

/** List explicit rollout rows for operator inspection. */
export async function listWorkbenchRollouts(): Promise<WorkbenchRolloutRow[]> {
  return query<WorkbenchRolloutRow>(
    `SELECT r.*, p.name AS project_name
       FROM runtime_box_workbench_rollouts r
       JOIN projects p ON p.id=r.project_id
      ORDER BY r.updated_at DESC, p.name ASC`,
  );
}

/** Upsert one auditable Project override. Disabled is an explicit rollback state. */
export async function setWorkbenchRollout(input: {
  projectId: string;
  status: WorkbenchRolloutStatus;
  cohort?: string | null;
  reason?: string | null;
  config?: Record<string, unknown>;
  actorUserId: number;
}): Promise<WorkbenchRolloutRow> {
  const project = await queryOne<{ id: string }>(
    `SELECT id FROM projects
      WHERE id=$1 AND COALESCE(archived,0)=0 AND COALESCE(lifecycle_status,'active')='active'`,
    [input.projectId],
  );
  if (!project) throw new Error('Active Project not found');
  const row = await queryOne<WorkbenchRolloutRow>(
    `INSERT INTO runtime_box_workbench_rollouts
       (project_id,status,cohort,reason,config_json,updated_by_user_id,enabled_at,disabled_at)
     VALUES($1,$2,$3,$4,$5::jsonb,$6,
       CASE WHEN $2='enabled' THEN NOW() ELSE NULL END,
       CASE WHEN $2='disabled' THEN NOW() ELSE NULL END)
     ON CONFLICT(project_id) DO UPDATE SET
       status=EXCLUDED.status,
       cohort=EXCLUDED.cohort,
       reason=EXCLUDED.reason,
       config_json=EXCLUDED.config_json,
       updated_by_user_id=EXCLUDED.updated_by_user_id,
       enabled_at=CASE WHEN EXCLUDED.status='enabled' THEN COALESCE(runtime_box_workbench_rollouts.enabled_at,NOW()) ELSE runtime_box_workbench_rollouts.enabled_at END,
       disabled_at=CASE WHEN EXCLUDED.status='disabled' THEN NOW() ELSE NULL END,
       updated_at=NOW()
     RETURNING *`,
    [
      input.projectId,
      input.status,
      input.cohort?.trim() || null,
      input.reason?.trim() || null,
      JSON.stringify(input.config ?? {}),
      input.actorUserId,
    ],
  );
  if (!row) throw new Error('Workbench rollout update failed');
  return row;
}
