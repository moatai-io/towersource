/**
 * Owns: the single Backend admission boundary for Project Environment execution.
 * Public API: resolveProjectExecutionContext.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { queryOne } from '../../db/pg-repo.js';
import { requireCurrentAgentExecutionAccess } from '../authority/agent-execution-access.js';
import { readLegacyProjectComputePlacement } from './adapters/legacy-project-compute-adapter.js';
import { listProjectWorkspaceAuthorities } from './project-workspace-authority.js';

export type ProjectEnvironmentMode = 'legacy-worker-workspace' | 'canonical-project-workspace';

/** Shared read-only classification for execution admission and administration. */
export function classifyProjectEnvironment(storageKind: 'host' | 'worker' | undefined, workstationMode: boolean): ProjectEnvironmentMode {
  return storageKind === 'worker' || (!storageKind && workstationMode)
    ? 'legacy-worker-workspace' : 'canonical-project-workspace';
}

export interface ResolvedProjectExecutionContext {
  projectId: string;
  deploymentId: string;
  actorUserId: number;
  sessionId: string;
  userRole: string;
  projectWritable: boolean;
  projectRoot: string;
  logicalRoot: '/workspace';
  environmentMode: ProjectEnvironmentMode;
  preferredExecutorId?: string;
  requiredCapabilities: string[];
}

interface ProjectExecutionContextDependencies {
  requireAccess: typeof requireCurrentAgentExecutionAccess;
  readProject(projectId: string): Promise<{ rootPath: string; lifecycleStatus: string; archived: boolean } | undefined>;
  readLegacyPlacement: typeof readLegacyProjectComputePlacement;
  readWorkspaceAuthorities: typeof listProjectWorkspaceAuthorities;
  realpath(value: string): Promise<string>;
}

const defaultDependencies: ProjectExecutionContextDependencies = {
  requireAccess: requireCurrentAgentExecutionAccess,
  async readProject(projectId) {
    const row = await queryOne<{ root_path: string | null; lifecycle_status: string | null; archived: number | null }>(
      'SELECT root_path,lifecycle_status,archived FROM projects WHERE id=$1',
      [projectId],
    );
    if (!row?.root_path) return undefined;
    return { rootPath: row.root_path, lifecycleStatus: row.lifecycle_status ?? (row.archived ? 'retired' : 'active'), archived: Boolean(row.archived) };
  },
  readLegacyPlacement: readLegacyProjectComputePlacement,
  readWorkspaceAuthorities: listProjectWorkspaceAuthorities,
  realpath: fs.realpath,
};

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].sort();
}

/** Resolve authority and canonical workspace before choosing or contacting an executor. */
export async function resolveProjectExecutionContext(input: {
  executionScope?: 'project' | 'organization';
  projectId: string;
  actorUserId: number;
  sessionId: string;
  deploymentId: string;
  requiredCapabilities: string[];
  expectedProjectRoot?: string;
}, dependencies: ProjectExecutionContextDependencies = defaultDependencies): Promise<ResolvedProjectExecutionContext> {
  if (!input.projectId.trim() || !input.sessionId.trim()) throw new Error('PROJECT_EXECUTION_CONTEXT_REQUIRED');
  if (!Number.isSafeInteger(input.actorUserId) || input.actorUserId <= 0) throw new Error('PROJECT_EXECUTION_CONTEXT_REQUIRED');
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(input.deploymentId)) throw new Error('PROJECT_EXECUTION_DEPLOYMENT_INVALID');

  if (input.executionScope !== undefined && !['project', 'organization'].includes(input.executionScope)) {
    throw new Error('EXECUTION_SCOPE_INVALID');
  }
  if (input.executionScope === 'organization') throw new Error('EXECUTION_SCOPE_UNSUPPORTED');
  const access = await dependencies.requireAccess({ projectId: input.projectId, userId: input.actorUserId });
  const project = await dependencies.readProject(input.projectId);
  if (!project || project.archived || project.lifecycleStatus !== 'active') throw new Error('PROJECT_EXECUTION_INACTIVE');

  const storage = (await dependencies.readWorkspaceAuthorities(input.deploymentId))
    .find(row => row.project_id === input.projectId && row.deployment_id === input.deploymentId);
  if (storage?.state && storage.state !== 'ready') throw new Error('WORKSPACE_STORAGE_NOT_READY');

  const binding = await dependencies.readLegacyPlacement(input.projectId, input.deploymentId);
  let environmentMode: ProjectEnvironmentMode = 'canonical-project-workspace';
  let preferredExecutorId = binding?.defaultWorkerId?.trim() || undefined;
  if (classifyProjectEnvironment(storage?.storage_kind, Boolean(binding?.workstationMode)) === 'legacy-worker-workspace') {
    environmentMode = 'legacy-worker-workspace';
    const storageWorkerId = storage?.worker_id?.trim() || undefined;
    if (!storageWorkerId && !preferredExecutorId) throw new Error('LEGACY_WORKER_BINDING_REQUIRED');
    if (storageWorkerId && preferredExecutorId && storageWorkerId !== preferredExecutorId) throw new Error('WORKSPACE_STORAGE_WORKER_MISMATCH');
    preferredExecutorId = storageWorkerId ?? preferredExecutorId;
  } else if (storage?.storage_kind === 'host' && storage.worker_id !== null) {
    throw new Error('WORKSPACE_STORAGE_CONFIGURATION_CONFLICT');
  }

  let projectRoot: string;
  try { projectRoot = await dependencies.realpath(path.resolve(project.rootPath)); }
  catch { throw new Error('PROJECT_ROOT_NOT_READY'); }
  if (!path.isAbsolute(projectRoot)) throw new Error('PROJECT_ROOT_INVALID');
  if (input.expectedProjectRoot) {
    let expected: string;
    try { expected = await dependencies.realpath(path.resolve(input.expectedProjectRoot)); }
    catch { throw new Error('PROJECT_ROOT_NOT_READY'); }
    if (expected !== projectRoot) throw new Error('PROJECT_ROOT_MISMATCH');
  }

  return Object.freeze({
    projectId: input.projectId, deploymentId: input.deploymentId, actorUserId: input.actorUserId, sessionId: input.sessionId,
    userRole: access.userRole, projectWritable: access.projectWritable, projectRoot, logicalRoot: '/workspace', environmentMode,
    ...(preferredExecutorId ? { preferredExecutorId } : {}), requiredCapabilities: sortedUnique(input.requiredCapabilities),
  });
}
