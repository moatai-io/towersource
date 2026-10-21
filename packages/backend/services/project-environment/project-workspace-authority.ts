import { query, queryOne } from '../../db/pg-repo.js';
import { readLegacyProjectComputePlacement } from './adapters/legacy-project-compute-adapter.js';

export interface ProjectWorkspaceAuthority {
  project_id: string;
  deployment_id: string;
  storage_kind: 'host' | 'worker';
  worker_id: string | null;
  state: 'pending' | 'ready' | 'blocked';
  version: number;
}

/** Only a missing additive table permits compatibility. DB/auth failures propagate. */
export async function listProjectWorkspaceAuthorities(deploymentId: string): Promise<ProjectWorkspaceAuthority[]> {
  try {
    return await query<ProjectWorkspaceAuthority>('SELECT project_id,deployment_id,storage_kind,worker_id,state,version FROM project_file_storage_bindings WHERE deployment_id=$1', [deploymentId]);
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === '42P01'
      && error.message.includes('project_file_storage_bindings')) return [];
    throw error;
  }
}

/** Provision the canonical host workspace for a newly created Project. */
export async function provisionCanonicalProjectWorkspace(input: {
  projectId: string;
  deploymentId: string;
}): Promise<ProjectWorkspaceAuthority> {
  if (!input.projectId.trim()) throw new Error('PROJECT_WORKSPACE_PROJECT_REQUIRED');
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(input.deploymentId)) throw new Error('PROJECT_WORKSPACE_DEPLOYMENT_INVALID');
  const row = await queryOne<ProjectWorkspaceAuthority>(
    `INSERT INTO project_file_storage_bindings(project_id,deployment_id,storage_kind,worker_id,state,version)
     VALUES($1,$2,'host',NULL,'ready',1)
     ON CONFLICT(project_id,deployment_id) DO NOTHING
     RETURNING project_id,deployment_id,storage_kind,worker_id,state,version`,
    [input.projectId, input.deploymentId],
  );
  if (row) return row;
  const current = (await listProjectWorkspaceAuthorities(input.deploymentId))
    .find(authority => authority.project_id === input.projectId && authority.deployment_id === input.deploymentId);
  if (!current) throw new Error('PROJECT_WORKSPACE_PROVISION_FAILED');
  if (current.storage_kind !== 'host' || current.worker_id !== null || current.state !== 'ready') {
    throw new Error('PROJECT_WORKSPACE_ALREADY_BOUND_DIFFERENTLY');
  }
  return current;
}

export function explicitProjectWorkspaceTarget(authority: ProjectWorkspaceAuthority): { workstationMode: boolean; defaultWorkerId: string | null } {
  if (authority.state !== 'ready') throw new Error('WORKSPACE_STORAGE_NOT_READY');
  if (authority.storage_kind === 'host' && authority.worker_id === null) return { workstationMode: false, defaultWorkerId: null };
  if (authority.storage_kind === 'worker' && authority.worker_id?.trim()) return { workstationMode: true, defaultWorkerId: authority.worker_id };
  throw new Error('WORKSPACE_STORAGE_CONFIGURATION_CONFLICT');
}

/** Explicit workspace authority wins even when compute placement changes or is disabled. */
export async function resolveProjectWorkspaceTarget(projectId: string, deploymentId: string) {
  const authorities = await listProjectWorkspaceAuthorities(deploymentId);
  const authority = authorities.find(row => row.project_id === projectId && row.deployment_id === deploymentId);
  return authority ? explicitProjectWorkspaceTarget(authority) : readLegacyProjectComputePlacement(projectId, deploymentId);
}
