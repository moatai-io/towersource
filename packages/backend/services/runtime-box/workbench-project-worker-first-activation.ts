/**
 * Owns: atomic activation of the three control-plane records required for Worker-first Project bash.
 * Public API: activateProjectWorkerFirst, activateProjectWorkerFirstWithClient.
 *
 * Call only after Worker scope, identity, heartbeat, transport, and direct execution smoke pass.
 */
import type { PoolClient } from 'pg';
import { transaction } from '../../db/pg-repo.js';
import type { ProjectComputeAuthorityMode } from './workbench-project-compute-settings.js';

export interface ProjectWorkerFirstActivationInput {
  projectId: string;
  deploymentId: string;
  workerId: string;
  authorityMode?: ProjectComputeAuthorityMode;
  actorUserId: number;
  rolloutCohort?: string | null;
  reason: string;
}

export interface ProjectWorkerFirstActivationResult {
  projectId: string;
  deploymentId: string;
  workerId: string;
  workstationMode: true;
  authorityMode: ProjectComputeAuthorityMode;
  rolloutStatus: 'enabled';
}

function validate(input: ProjectWorkerFirstActivationInput): void {
  if (!input.projectId.trim()) throw new Error('PROJECT_ID_REQUIRED');
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(input.deploymentId)) throw new Error('PROJECT_COMPUTE_DEPLOYMENT_ID_INVALID');
  if (!input.workerId.trim()) throw new Error('WORKER_ID_REQUIRED');
  if (!input.reason.trim()) throw new Error('WORKER_FIRST_ACTIVATION_REASON_REQUIRED');
}

/** Use this inside a caller-owned transaction when assignment lease checks must commit atomically too. */
export async function activateProjectWorkerFirstWithClient(
  client: PoolClient,
  input: ProjectWorkerFirstActivationInput,
): Promise<ProjectWorkerFirstActivationResult> {
  validate(input);
  const authorityMode = input.authorityMode ?? 'project';
  const values = [input.projectId, input.workerId.trim(), authorityMode, input.actorUserId];

  await client.query(
    `INSERT INTO project_compute_settings(project_id,default_worker_id,workstation_mode,authority_mode,updated_by_user_id)
     VALUES($1,$2,TRUE,$3,$4)
     ON CONFLICT(project_id) DO UPDATE SET
       default_worker_id=EXCLUDED.default_worker_id,workstation_mode=TRUE,
       authority_mode=EXCLUDED.authority_mode,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=NOW()`,
    values,
  );
  await client.query(
    `INSERT INTO project_compute_deployment_bindings(project_id,deployment_id,default_worker_id,workstation_mode,authority_mode,updated_by_user_id)
     VALUES($1,$2,$3,TRUE,$4,$5)
     ON CONFLICT(project_id,deployment_id) DO UPDATE SET
       default_worker_id=EXCLUDED.default_worker_id,workstation_mode=TRUE,
       authority_mode=EXCLUDED.authority_mode,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=NOW()`,
    [input.projectId, input.deploymentId, input.workerId.trim(), authorityMode, input.actorUserId],
  );
  await client.query(
    `INSERT INTO runtime_box_workbench_rollouts
       (project_id,status,cohort,reason,config_json,updated_by_user_id,enabled_at,disabled_at)
     VALUES($1,'enabled',$2,$3,'{}'::jsonb,$4,NOW(),NULL)
     ON CONFLICT(project_id) DO UPDATE SET
       status='enabled',cohort=EXCLUDED.cohort,reason=EXCLUDED.reason,
       updated_by_user_id=EXCLUDED.updated_by_user_id,
       enabled_at=COALESCE(runtime_box_workbench_rollouts.enabled_at,NOW()),disabled_at=NULL,updated_at=NOW()`,
    [input.projectId, input.rolloutCohort?.trim() || null, input.reason.trim(), input.actorUserId],
  );

  return {
    projectId: input.projectId,
    deploymentId: input.deploymentId,
    workerId: input.workerId.trim(),
    workstationMode: true,
    authorityMode,
    rolloutStatus: 'enabled',
  };
}

/** Standalone control-plane entry point; all three records commit or roll back together. */
export async function activateProjectWorkerFirst(
  input: ProjectWorkerFirstActivationInput,
): Promise<ProjectWorkerFirstActivationResult> {
  return transaction(client => activateProjectWorkerFirstWithClient(client, input));
}
