/**
 * Owns: Project-level Worker-first compute preferences.
 * Public API: get/upsert Project default Worker and workstation mode.
 *
 * This stores non-secret control-plane preferences only. Execution authority remains
 * Worker registry scope/capability/liveness/capacity plus transport authentication.
 */

import { execute, queryOne } from '../../db/pg-repo.js';

export type ProjectComputeAuthorityMode = 'project' | 'operator-plane' | 'sandbox';

export interface ProjectComputeSettings {
  projectId: string;
  deploymentId?: string;
  defaultWorkerId: string | null;
  workstationMode: boolean;
  authorityMode: ProjectComputeAuthorityMode;
  updatedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

type ProjectComputeSettingsRow = {
  project_id: string;
  default_worker_id: string | null;
  workstation_mode: boolean;
  authority_mode?: ProjectComputeAuthorityMode;
  updated_by_user_id: number | null;
  created_at: string;
  updated_at: string;
};

function normalize(row: ProjectComputeSettingsRow): ProjectComputeSettings {
  return {
    projectId: row.project_id,
    defaultWorkerId: row.default_worker_id,
    workstationMode: row.workstation_mode,
    authorityMode: row.authority_mode ?? 'project',
    updatedByUserId: row.updated_by_user_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

type ProjectComputeDeploymentRow = ProjectComputeSettingsRow & { deployment_id: string };

/** Read Project compute preferences. Missing row means legacy/env defaults. */
export async function getProjectComputeSettings(projectId: string): Promise<ProjectComputeSettings | undefined> {
  const row = await queryOne<ProjectComputeSettingsRow>(
    'SELECT * FROM project_compute_settings WHERE project_id=$1',
    [projectId],
  );
  return row ? normalize(row) : undefined;
}

/** Read an exact deployment binding; missing means this deployment has not activated Worker-first. */
export async function getProjectComputeDeploymentBinding(projectId: string, deploymentId: string): Promise<ProjectComputeSettings | undefined> {
  const row = await queryOne<ProjectComputeDeploymentRow>(
    'SELECT * FROM project_compute_deployment_bindings WHERE project_id=$1 AND deployment_id=$2',
    [projectId, deploymentId],
  );
  return row ? { ...normalize(row), deploymentId: row.deployment_id } : undefined;
}

/** Upsert an exact deployment binding without changing another Tower execution plane. */
export async function upsertProjectComputeDeploymentBinding(input: {
  projectId: string;
  deploymentId: string;
  defaultWorkerId?: string | null;
  workstationMode?: boolean;
  authorityMode?: ProjectComputeAuthorityMode;
  updatedByUserId?: number | null;
}): Promise<ProjectComputeSettings> {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(input.deploymentId)) throw new Error('PROJECT_COMPUTE_DEPLOYMENT_ID_INVALID');
  const row = await queryOne<ProjectComputeDeploymentRow>(
    `INSERT INTO project_compute_deployment_bindings(project_id,deployment_id,default_worker_id,workstation_mode,authority_mode,updated_by_user_id)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(project_id,deployment_id) DO UPDATE SET
       default_worker_id=EXCLUDED.default_worker_id,workstation_mode=EXCLUDED.workstation_mode,
       authority_mode=EXCLUDED.authority_mode,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=NOW()
     RETURNING *`,
    [input.projectId, input.deploymentId, input.defaultWorkerId?.trim() || null,
      input.workstationMode ?? false, input.authorityMode ?? 'project', input.updatedByUserId ?? null],
  );
  if (!row) throw new Error('PROJECT_COMPUTE_DEPLOYMENT_BINDING_UPSERT_FAILED');
  return { ...normalize(row), deploymentId: row.deployment_id };
}

/** Upsert non-secret Project compute preferences from explicit control-plane code. */
export async function upsertProjectComputeSettings(input: {
  projectId: string;
  defaultWorkerId?: string | null;
  workstationMode?: boolean;
  authorityMode?: ProjectComputeAuthorityMode;
  updatedByUserId?: number | null;
}): Promise<ProjectComputeSettings> {
  const row = await queryOne<ProjectComputeSettingsRow>(
    `INSERT INTO project_compute_settings(project_id,default_worker_id,workstation_mode,authority_mode,updated_by_user_id)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(project_id) DO UPDATE SET
       default_worker_id=EXCLUDED.default_worker_id,
       workstation_mode=EXCLUDED.workstation_mode,
       authority_mode=EXCLUDED.authority_mode,
       updated_by_user_id=EXCLUDED.updated_by_user_id,
       updated_at=NOW()
     RETURNING *`,
    [
      input.projectId,
      input.defaultWorkerId?.trim() || null,
      input.workstationMode ?? false,
      input.authorityMode ?? 'project',
      input.updatedByUserId ?? null,
    ],
  );
  if (!row) throw new Error('PROJECT_COMPUTE_SETTINGS_UPSERT_FAILED');
  return normalize(row);
}

/** Remove settings to return a Project to legacy/env defaults. */
export async function deleteProjectComputeSettings(projectId: string): Promise<boolean> {
  return (await execute('DELETE FROM project_compute_settings WHERE project_id=$1', [projectId])).changes === 1;
}
