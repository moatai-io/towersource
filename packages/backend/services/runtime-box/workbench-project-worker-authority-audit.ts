import { listProjectWorkspaceAuthorities, explicitProjectWorkspaceTarget, type ProjectWorkspaceAuthority } from '../project-environment/project-workspace-authority.js';
import { getPersistedWorkbenchWorker } from '../execution/worker/worker-repository.js';
import { query } from '../../db/pg-repo.js';

export type ProjectWorkerAuthorityProblem =
  | 'file_authority_storage_not_ready'
  | 'file_authority_storage_invalid'
  | 'file_authority_binding_incomplete'
  | 'file_authority_worker_missing'
  | 'file_authority_scope_missing'
  | 'deployment_worker_missing'
  | 'rollout_not_enabled'
  | 'settings_binding_worker_mismatch'
  | 'active_desire_binding_missing'
  | 'active_desire_worker_mismatch';

export interface ProjectWorkerAuthorityAuditRow {
  explicit_storage?: ProjectWorkspaceAuthority;
  storage_worker_exists?: boolean;
  storage_worker_project_ids?: string[];
  project_id: string;
  project_name: string;
  root_path: string | null;
  settings_worker_id: string | null;
  settings_workstation_mode: boolean | null;
  binding_worker_id: string | null;
  binding_workstation_mode: boolean | null;
  settings_worker_exists: boolean;
  settings_worker_project_ids: string[] | null;
  binding_worker_exists: boolean;
  binding_worker_project_ids: string[] | null;
  rollout_status: string | null;
  desire_worker_id: string | null;
  desire_status: string | null;
}

export interface ProjectWorkerAuthorityFinding {
  projectId: string;
  projectName: string;
  rootPath: string | null;
  severity: 'critical' | 'warning';
  problems: ProjectWorkerAuthorityProblem[];
  state: {
    settingsWorkerId: string | null;
    fileAuthorityEnabled: boolean;
    bindingWorkerId: string | null;
    executionBindingEnabled: boolean;
    workerProjectScope: boolean;
    rolloutStatus: string | null;
    desireWorkerId: string | null;
    desireStatus: string | null;
  };
}

/** Pure classifier kept separate so drift rules can be regression-tested without PostgreSQL. */
export function classifyProjectWorkerAuthorityRow(row: ProjectWorkerAuthorityAuditRow, deploymentId = 'production'): ProjectWorkerAuthorityFinding | undefined {
  const problems: ProjectWorkerAuthorityProblem[] = [];
  // Match resolveEffectiveWorkbenchBinding: an explicit deployment row wins,
  // including disabled rows. Legacy fallback is development-only.
  const useBinding = row.binding_workstation_mode !== null;
  let fileAuthorityEnabled = useBinding
    ? row.binding_workstation_mode === true
    : deploymentId === 'development' && row.settings_workstation_mode === true;
  let fileWorkerId = useBinding ? row.binding_worker_id : row.settings_worker_id;
  let fileWorkerExists = useBinding ? row.binding_worker_exists : row.settings_worker_exists;
  let fileWorkerScope = useBinding ? row.binding_worker_project_ids : row.settings_worker_project_ids;
  if (row.explicit_storage) {
    try {
      const target = explicitProjectWorkspaceTarget(row.explicit_storage);
      fileAuthorityEnabled = target.workstationMode;
      fileWorkerId = target.defaultWorkerId;
      fileWorkerExists = row.storage_worker_exists ?? false;
      fileWorkerScope = row.storage_worker_project_ids ?? [];
    } catch (error) {
      problems.push(error instanceof Error && error.message === 'WORKSPACE_STORAGE_NOT_READY'
        ? 'file_authority_storage_not_ready' : 'file_authority_storage_invalid');
      fileAuthorityEnabled = false;
    }
  }
  const executionBindingEnabled = row.binding_workstation_mode === true && Boolean(row.binding_worker_id);
  const workerProjectScope = Boolean(fileWorkerExists && fileWorkerScope?.includes(row.project_id));

  if (fileAuthorityEnabled && !fileWorkerId) problems.push('file_authority_binding_incomplete');
  else if (fileAuthorityEnabled && !fileWorkerExists) problems.push('file_authority_worker_missing');
  else if (fileAuthorityEnabled && !workerProjectScope) problems.push('file_authority_scope_missing');
  if (executionBindingEnabled && !row.binding_worker_exists) problems.push('deployment_worker_missing');
  if (executionBindingEnabled && row.rollout_status !== 'enabled') problems.push('rollout_not_enabled');
  if (!row.explicit_storage && fileAuthorityEnabled && executionBindingEnabled && row.settings_worker_id !== row.binding_worker_id) {
    problems.push('settings_binding_worker_mismatch');
  }
  if (row.desire_status === 'active' && !executionBindingEnabled) problems.push('active_desire_binding_missing');
  if (row.desire_status === 'active' && executionBindingEnabled && row.desire_worker_id !== row.binding_worker_id) {
    problems.push('active_desire_worker_mismatch');
  }
  if (problems.length === 0) return undefined;

  const critical = problems.some(problem => [
    'file_authority_storage_not_ready',
    'file_authority_storage_invalid',
    'file_authority_binding_incomplete',
    'file_authority_worker_missing',
    'file_authority_scope_missing',
    'settings_binding_worker_mismatch',
  ].includes(problem));
  return {
    projectId: row.project_id,
    projectName: row.project_name,
    rootPath: row.root_path,
    severity: critical ? 'critical' : 'warning',
    problems,
    state: {
      settingsWorkerId: row.settings_worker_id,
      fileAuthorityEnabled,
      bindingWorkerId: row.binding_worker_id,
      executionBindingEnabled,
      workerProjectScope,
      rolloutStatus: row.rollout_status,
      desireWorkerId: row.desire_worker_id,
      desireStatus: row.desire_status,
    },
  };
}

/** Read-only audit of active Projects. Diagnoses the effective file binding, not the legacy activation intent. */
export async function auditProjectWorkerAuthority(deploymentId = 'production'): Promise<ProjectWorkerAuthorityFinding[]> {
  const rows = await query<ProjectWorkerAuthorityAuditRow>(
    `SELECT p.id AS project_id,p.name AS project_name,p.root_path,
            s.default_worker_id AS settings_worker_id,s.workstation_mode AS settings_workstation_mode,
            b.default_worker_id AS binding_worker_id,b.workstation_mode AS binding_workstation_mode,
            (sw.worker_id IS NOT NULL) AS settings_worker_exists,sw.project_ids AS settings_worker_project_ids,
            (bw.worker_id IS NOT NULL) AS binding_worker_exists,bw.project_ids AS binding_worker_project_ids,
            r.status AS rollout_status,d.desired_worker_id AS desire_worker_id,d.status AS desire_status
       FROM projects p
       LEFT JOIN project_compute_settings s ON s.project_id=p.id
       LEFT JOIN project_compute_deployment_bindings b ON b.project_id=p.id AND b.deployment_id=$1
       LEFT JOIN runtime_box_workbench_workers sw ON sw.worker_id=s.default_worker_id
       LEFT JOIN runtime_box_workbench_workers bw ON bw.worker_id=b.default_worker_id
       LEFT JOIN runtime_box_workbench_rollouts r ON r.project_id=p.id
       LEFT JOIN project_worker_assignment_desires d ON d.project_id=p.id AND d.deployment_id=$1
      WHERE COALESCE(p.archived,0)=0
        AND COALESCE(p.lifecycle_status,'active')='active'
      ORDER BY p.name,p.id`,
    [deploymentId],
  );
  const storageBindings = await listProjectWorkspaceAuthorities(deploymentId);
  for (const row of rows) {
    const storage = storageBindings.find(binding => binding.project_id === row.project_id && binding.deployment_id === deploymentId);
    if (!storage) continue;
    row.explicit_storage = storage;
    if (storage.storage_kind === 'worker' && storage.worker_id) {
      const worker = await getPersistedWorkbenchWorker(storage.worker_id);
      row.storage_worker_exists = Boolean(worker);
      row.storage_worker_project_ids = worker?.projectIds ?? [];
    }
  }
  return rows.flatMap(row => classifyProjectWorkerAuthorityRow(row, deploymentId) ?? []);
}
