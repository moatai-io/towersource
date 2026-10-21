#!/usr/bin/env node
/**
 * Owns: final control-plane activation of the single-host OSS local Worker after its direct smoke passes.
 * Public API: CLI configured by TOWER_OSS_* environment variables.
 */
import { activateProjectWorkerFirst } from '../services/runtime-box/workbench-project-worker-first-activation.js';
import { getPersistedWorkbenchWorker } from '../services/execution/worker/worker-repository.js';
import { closePgPool } from '../db/pg.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const projectId = required('TOWER_OSS_PROJECT_ID');
  const workerId = required('TOWER_OSS_WORKER_ID');
  const actorUserId = Number(required('TOWER_OSS_ACTOR_USER_ID'));
  if (!Number.isSafeInteger(actorUserId) || actorUserId < 1) throw new Error('TOWER_OSS_ACTOR_USER_ID is invalid');

  const worker = await getPersistedWorkbenchWorker(workerId);
  if (!worker || worker.status !== 'healthy' || !worker.projectIds.includes(projectId)) {
    throw new Error('OSS_LOCAL_WORKER_NOT_HEALTHY_FOR_PROJECT');
  }

  const result = await activateProjectWorkerFirst({
    projectId,
    deploymentId: 'production',
    workerId,
    authorityMode: 'project',
    actorUserId,
    rolloutCohort: 'oss-single-host',
    reason: 'Tower OSS single-host local Worker bootstrap verified by direct execution smoke',
    fileAuthorityReady: true,
    verificationEvidence: 'worker-file-roundtrip',
  });
  console.log(JSON.stringify({ status: 'active', ...result }));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ status: 'error', error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  })
  .finally(() => closePgPool());
