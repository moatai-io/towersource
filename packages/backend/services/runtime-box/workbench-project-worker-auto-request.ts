/**
 * Owns: best-effort pending Worker assignment request after a Project is fully created.
 * Public API: requestAutomaticProjectWorkerAssignment.
 */
import path from 'node:path';
import { config } from '../../config.js';
import { getPersistedWorkbenchWorker } from '../execution/worker/worker-repository.js';
import { requestProjectWorkerAssignment } from './workbench-project-worker-assignment.js';

/** Queue only standard, production, user-facing Projects; never fail Project creation. */
export async function requestAutomaticProjectWorkerAssignment(input: {
  projectId: string;
  rootPath: string;
  userId?: number | null;
  systemKey?: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<'queued' | 'skipped'> {
  const env = input.env ?? process.env;
  if (env.NODE_ENV !== 'production' || input.systemKey) return 'skipped';
  const root = path.resolve(input.rootPath);
  const projectsRoot = path.resolve(config.workspaceRoot, 'projects');
  if (!root.startsWith(`${projectsRoot}${path.sep}`)) return 'skipped';
  const workerId = env.TOWER_PRIMARY_WORKER_ID?.trim();
  if (!workerId) return 'skipped';
  const worker = await getPersistedWorkbenchWorker(workerId);
  if (!worker || worker.deploymentId !== 'production' || worker.status !== 'healthy' || worker.draining) return 'skipped';
  await requestProjectWorkerAssignment({
    projectId: input.projectId,
    deploymentId: 'production',
    workerId,
    requestedByUserId: input.userId ?? null,
    reason: 'Automatic assignment after standard Project creation',
  });
  return 'queued';
}
