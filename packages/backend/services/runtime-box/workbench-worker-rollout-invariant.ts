import { query } from '../../db/pg-repo.js';

export interface WorkerRolloutInvariantRow {
  project_id: string;
  project_name: string;
  worker_id: string;
  rollout_status: string | null;
}

/**
 * Worker-first Project bash requires both the deployment binding and an enabled
 * Workbench rollout. Return only drift rows so operators and Fleet preflight can
 * fail closed before disabling Runtime Box compatibility.
 */
export async function listWorkerRolloutInvariantDrift(deploymentId = 'production'): Promise<WorkerRolloutInvariantRow[]> {
  return query<WorkerRolloutInvariantRow>(
    `SELECT p.id AS project_id,
            p.name AS project_name,
            b.default_worker_id AS worker_id,
            r.status AS rollout_status
       FROM projects p
       JOIN project_compute_deployment_bindings b
         ON b.project_id=p.id AND b.deployment_id=$1
       LEFT JOIN runtime_box_workbench_rollouts r ON r.project_id=p.id
      WHERE COALESCE(p.archived,0)=0
        AND COALESCE(p.lifecycle_status,'active')='active'
        AND b.workstation_mode=TRUE
        AND b.default_worker_id IS NOT NULL
        AND COALESCE(r.status,'disabled') <> 'enabled'
      ORDER BY p.name,p.id`,
    [deploymentId],
  );
}

export async function assertWorkerRolloutInvariant(deploymentId = 'production'): Promise<void> {
  const drift = await listWorkerRolloutInvariantDrift(deploymentId);
  if (drift.length === 0) return;
  const sample = drift.slice(0, 5).map(row => `${row.project_name}(${row.project_id})->${row.worker_id}:${row.rollout_status ?? 'missing'}`).join(', ');
  throw new Error(`WORKER_ROLLOUT_INVARIANT_VIOLATION: ${drift.length} Worker-bound Project(s) lack enabled rollout; ${sample}`);
}
