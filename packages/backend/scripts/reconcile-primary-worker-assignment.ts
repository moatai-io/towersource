#!/usr/bin/env node
/**
 * Owns: one-shot same-VM production primary Worker assignment reconciliation.
 * Public API: CLI; claims at most one desired assignment per invocation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { issueWorkbenchWorkerIdentity } from '../services/runtime-box/workbench-worker-identity.js';
import { getPersistedWorkbenchWorker } from '../services/execution/worker/worker-repository.js';
import { getWorkbenchWorkerIdentity, recordWorkbenchWorkerIdentity, rotateWorkbenchWorkerIdentity } from '../services/runtime-box/workbench-worker-identity-repository.js';
import { resolveWorkbenchWorkerTransportToken } from '../services/execution/worker/worker-transport-credentials.js';
import { createRemoteWorkbenchHttpTransport } from '../services/execution/worker/worker-http-transport.js';
import { query, queryOne, transaction } from '../db/pg-repo.js';
import { closePgPool } from '../db/pg.js';
import {
  claimProjectWorkerAssignment, completeProjectWorkerAssignment, failProjectWorkerAssignment, markProjectWorkerAssignmentRecoveryRequired,
  type ProjectWorkerAssignmentDesire,
} from '../services/runtime-box/workbench-project-worker-assignment.js';
import { reconcileClaimedProjectWorkerAssignment } from '../services/runtime-box/workbench-project-worker-assignment-reconciler.js';
import { activateProjectWorkerFirstWithClient } from '../services/runtime-box/workbench-project-worker-first-activation.js';
import { requestProjectWorkerAssignment } from '../services/runtime-box/workbench-project-worker-assignment.js';
import { sharedStorageVerificationConfig, verifyBackendProcessIdentity } from '../services/runtime-box/workbench-storage-smoke-identity.js';
import { runBackendStorageSmoke } from '../services/runtime-box/workbench-storage-smoke-runner.js';
import { verifyConfiguredStorageGroup } from '../services/runtime-box/project-storage-group-policy.js';

import { prepareWorkerWithRecovery } from '../services/runtime-box/workbench-worker-prepare-recovery.js';

const run = promisify(execFile);
const deploymentId = process.env.TOWER_ASSIGNMENT_DEPLOYMENT_ID?.trim() || 'production';
const workerId = process.env.TOWER_PRIMARY_WORKER_ID?.trim() || '';
if (!workerId) throw new Error('TOWER_PRIMARY_WORKER_ID_REQUIRED');
const legacyWorkerId = process.env.TOWER_ASSIGNMENT_PRIMARY_WORKER_ID?.trim();
if (legacyWorkerId && legacyWorkerId !== workerId) throw new Error('PRIMARY_WORKER_CONFIGURATION_MISMATCH');
const configFile = process.env.TOWER_ASSIGNMENT_WORKER_CONFIG?.trim() || path.join(process.env.HOME!, '.config/tower-workers', `${workerId}.json`);
const identityFile = process.env.TOWER_ASSIGNMENT_WORKER_IDENTITY?.trim() || path.join(process.env.HOME!, '.config/tower-workers', `${workerId}.identity.jwt`);
const installer = process.env.TOWER_ASSIGNMENT_WORKER_INSTALLER?.trim();
const systemManaged = process.env.TOWER_ASSIGNMENT_SERVICE_MANAGER?.trim() === 'system';
const workerUnit = process.env.TOWER_ASSIGNMENT_WORKER_UNIT?.trim()
  || (systemManaged ? `tower-workbench-worker-${workerId}.service` : 'tower-prod-workbench-worker.service');
const heartbeatUnit = process.env.TOWER_ASSIGNMENT_HEARTBEAT_UNIT?.trim()
  || (systemManaged ? `tower-workbench-worker-${workerId}-heartbeat.service` : 'tower-prod-workbench-worker-heartbeat.service');
const workspaceRoot = path.resolve(process.env.WORKSPACE_ROOT || '/home/tower/workspace');
const maxRuns = process.env.TOWER_ASSIGNMENT_PRIMARY_MAX_RUNS?.trim() || '20';
const workerPort = Number(process.env.TOWER_ASSIGNMENT_WORKER_PORT || 43325);
const serviceManager = process.env.TOWER_ASSIGNMENT_SERVICE_MANAGER?.trim() || 'user';
const actorUserId = Number(process.env.TOWER_ASSIGNMENT_ACTOR_USER_ID || 1);
const signedGrantMode = process.env.TOWER_WORKER_SIGNED_EXECUTION_GRANTS === 'true';
const automaticBackfill = process.env.TOWER_ASSIGNMENT_AUTO_BACKFILL === 'true';
// Trusted service-installation config, never Project/request input. Disabled and
// signed-grant-only modes remain explicitly unverified, preserving legacy flows.
const storageVerification = sharedStorageVerificationConfig(process.env, signedGrantMode);

function requiredFiles(): void {
  if (signedGrantMode) return;
  // No installer is needed on the no-mutation path.
  for (const file of [configFile, identityFile]) if (!fs.existsSync(file)) throw new Error(`ASSIGNMENT_INPUT_MISSING:${file}`);
}

async function project(projectId: string): Promise<{ root: string }> {
  const row = await queryOne<any>('SELECT root_path,system_key,archived,lifecycle_status FROM projects WHERE id=$1', [projectId]);
  if (!row || row.system_key || Number(row.archived || 0) !== 0 || !['active', null].includes(row.lifecycle_status)) throw new Error('PROJECT_NOT_AUTO_ASSIGNABLE');
  const root = path.resolve(row.root_path);
  const projectsRoot = path.join(workspaceRoot, 'projects');
  if (!root.startsWith(`${projectsRoot}${path.sep}`) || !fs.statSync(root).isDirectory()) throw new Error('PROJECT_ROOT_NOT_STANDARD');
  return { root };
}

async function verify(assignment: ProjectWorkerAssignmentDesire, root: string): Promise<void> {
  let worker;
  for (let attempt = 0; attempt < 30; attempt++) {
    worker = await getPersistedWorkbenchWorker(workerId);
    // Execution grants authorize commands, not the static file API. Never
    // declare a Project ready when attachments would still fail scope checks.
    const scopeReady = worker?.projectIds.includes(assignment.project_id);
    if (worker?.status === 'healthy' && scopeReady && worker.capacity.maxRuns === Number(maxRuns)) break;
    if (attempt === 29) throw new Error('PRIMARY_WORKER_HEARTBEAT_SCOPE_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const token = await resolveWorkbenchWorkerTransportToken(workerId, actorUserId);
  if (!token || !worker) throw new Error('PRIMARY_WORKER_TRANSPORT_UNAVAILABLE');
  const transport = createRemoteWorkbenchHttpTransport({ workerId, baseUrl: worker.baseUrl, token, ...(signedGrantMode ? { projectRoot: root } : {}) });
  const nonce = `assignment-${assignment.project_id}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const smokePath = `.tower-worker-assignment-smoke-${process.pid}-${Date.now()}.txt`;
  let stdout = '';
  const command = [
    'set -e',
    `(test "$(pwd)" = /workspace || test "$(pwd)" = ${JSON.stringify(root)})`,
    `printf %s ${JSON.stringify(nonce)} > ${JSON.stringify(smokePath)}`,
    `test \"$(cat ${JSON.stringify(smokePath)})\" = ${JSON.stringify(nonce)}`,
    `test -f ${JSON.stringify(smokePath)}`,
    `rm -f ${JSON.stringify(smokePath)}`,
    `test ! -e ${JSON.stringify(smokePath)}`,
    'printf assignment-file-roundtrip-ok',
  ].join(' && ');
  const result = await transport.execute({
    spec: { jobId: 990000000 + Math.floor(Math.random() * 1000000), projectId: assignment.project_id, actorUserId, command, cwd: '/workspace', timeoutSec: 30, workbenchRevision: null, environmentKeys: [], artifacts: [] },
    signal: AbortSignal.timeout(35_000), onStdout: chunk => { stdout += chunk; }, onStderr: () => {},
  });
  if (result.execResult.exit_code !== 0 || !stdout.includes('assignment-file-roundtrip-ok')) throw new Error('PRIMARY_WORKER_ASSIGNMENT_FILE_SMOKE_FAILED');
  verifyConfiguredStorageGroup(process.env);
  if (storageVerification.status !== 'required') return;
  verifyBackendProcessIdentity(storageVerification.backendPid, storageVerification.identity);
  await runBackendStorageSmoke({
    root, identity: storageVerification.identity,
    execute: async command => {
      const probe = await transport.execute({
        spec: { jobId: 990000000 + Math.floor(Math.random() * 1000000), projectId: assignment.project_id, actorUserId, command, cwd: '/workspace', timeoutSec: 30, workbenchRevision: null, environmentKeys: [], artifacts: [] },
        signal: AbortSignal.timeout(35_000), onStdout: () => {}, onStderr: () => {},
      });
      if (probe.execResult.exit_code !== 0) throw new Error('PRIMARY_WORKER_SHARED_STORAGE_SMOKE_FAILED');
    },
    upload: async (relativePath, content) => {
      const url = new URL(`/v1/files/${encodeURIComponent(assignment.project_id)}/content`, worker!.baseUrl);
      url.searchParams.set('path', relativePath);
      const response = await fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: content, signal: AbortSignal.timeout(35_000) });
      if (!response.ok) throw new Error(`PRIMARY_WORKER_UPLOAD_SMOKE_FAILED_${response.status}`);
      await response.arrayBuffer();
    },
  });
}

async function activate(assignment: ProjectWorkerAssignmentDesire): Promise<void> {
  await transaction(async client => {
    const current = await client.query(`SELECT status,lease_owner FROM project_worker_assignment_desires WHERE project_id=$1 AND deployment_id=$2 FOR UPDATE`, [assignment.project_id, deploymentId]);
    if (current.rows[0]?.status !== 'preparing' || current.rows[0]?.lease_owner !== assignment.lease_owner) throw new Error('ASSIGNMENT_LEASE_LOST');
    await activateProjectWorkerFirstWithClient(client, {
      projectId: assignment.project_id,
      deploymentId,
      workerId,
      authorityMode: 'project',
      actorUserId,
      rolloutCohort: 'primary-worker-assignment',
      requireUnbound: true,
      reason: `Automatic primary Worker-first activation for ${deploymentId}`,
      // Signed execution grants authorize individual Runs but do not add the
      // Project to the Worker's static file scope.
      fileAuthorityReady: !signedGrantMode,
      verificationEvidence: 'worker-file-roundtrip',
    });
  });
}

async function queueMissingAssignments(): Promise<number> {
  const missing = await query<any>(
    `SELECT p.id,p.user_id
       FROM projects p
       LEFT JOIN project_compute_deployment_bindings b ON b.project_id=p.id AND b.deployment_id=$1
       LEFT JOIN project_worker_assignment_desires d ON d.project_id=p.id AND d.deployment_id=$1
      WHERE COALESCE(p.archived,0)=0
        AND COALESCE(p.lifecycle_status,'active')='active'
        AND NULLIF(BTRIM(COALESCE(p.system_key,'')),'') IS NULL
        AND p.root_path IS NOT NULL
        AND b.project_id IS NULL
        AND d.project_id IS NULL
      ORDER BY p.created_at,p.id`,
    [deploymentId],
  );
  for (const row of missing) {
    await requestProjectWorkerAssignment({
      projectId: row.id,
      deploymentId,
      workerId,
      requestedByUserId: row.user_id ?? null,
      reason: 'Automatic backfill for active Project without primary Worker binding',
    });
  }
  return missing.length;
}

async function main(): Promise<void> {
  if (storageVerification.status === 'required') verifyBackendProcessIdentity(storageVerification.backendPid, storageVerification.identity);
  requiredFiles();
  const queued = automaticBackfill ? await queueMissingAssignments() : 0;
  // Recheck direct invocation after any backfill, BEFORE claiming a missing scope.
  const pending = await queryOne<{project_id:string;root_path:string}>(`SELECT d.project_id,p.root_path FROM project_worker_assignment_desires d
    JOIN projects p ON p.id=d.project_id WHERE d.deployment_id=$1 AND d.desired_worker_id=$2 AND d.status='pending'
    ORDER BY d.updated_at,d.project_id LIMIT 1`,[deploymentId,workerId]);
  if(pending) {
    const projects=JSON.parse(fs.readFileSync(configFile,'utf8')).projects;
    if(projects?.[pending.project_id]!==pending.root_path) {
      // A signed command grant cannot satisfy static file authority. Missing
      // scope always waits for the root-protected dedicated coordinator.
      console.log(JSON.stringify({status:'pending',reason:'SCOPE_DEDICATED_COORDINATOR_REQUIRED',mutatedWorker:false}));return;
    }
  }
  const assignment = await claimProjectWorkerAssignment({ deploymentId, workerId, owner: `host:${process.pid}`, leaseSeconds: 180 });
  if (!assignment) return void console.log(JSON.stringify({ status: 'idle', queued }));
  let target: { root: string };
  let originalConfig: { projects: Record<string, string> };
  try {
    // Read-only input failures must not leave a claimed lease preparing forever.
    target = await project(assignment.project_id);
    const existingBinding = await queryOne('SELECT project_id FROM project_compute_deployment_bindings WHERE project_id=$1 AND deployment_id=$2', [assignment.project_id, deploymentId]);
    if (existingBinding) throw new Error('ASSIGNMENT_EXISTING_BINDING_REQUIRES_EXPLICIT_CHANGE');
    originalConfig = JSON.parse(fs.readFileSync(configFile, 'utf8')) as { projects: Record<string, string> };
    if (!originalConfig.projects || typeof originalConfig.projects !== 'object' || Array.isArray(originalConfig.projects)) {
      throw new Error('ASSIGNMENT_CONFIG_INVALID');
    }
  } catch (error) {
    const code = error instanceof Error && ['PROJECT_NOT_AUTO_ASSIGNABLE', 'PROJECT_ROOT_NOT_STANDARD', 'ASSIGNMENT_EXISTING_BINDING_REQUIRES_EXPLICIT_CHANGE', 'ASSIGNMENT_CONFIG_INVALID'].includes(error.message)
      ? error.message : 'ASSIGNMENT_PREFLIGHT_INPUT_FAILED';
    const recorded = await failProjectWorkerAssignment({ projectId: assignment.project_id, deploymentId, leaseOwner: assignment.lease_owner!, error: code });
    if (!recorded) throw new Error('ASSIGNMENT_PREFLIGHT_LEASE_LOST');
    console.log(JSON.stringify({ status: 'failed', projectId: assignment.project_id, workerId, error: code, mutatedWorker: false }));
    process.exitCode = 1;
    return;
  }
  const nextProjects = { ...originalConfig.projects, [assignment.project_id]: target.root };
  const result = await reconcileClaimedProjectWorkerAssignment(assignment, {
    prepareWorker: async () => {
      const existingBinding = await queryOne('SELECT project_id FROM project_compute_deployment_bindings WHERE project_id=$1 AND deployment_id=$2', [assignment.project_id, deploymentId]);
      if (existingBinding) throw new Error('ASSIGNMENT_EXISTING_BINDING_REQUIRES_EXPLICIT_CHANGE');
      if(originalConfig.projects[assignment.project_id]!==target.root)throw new Error('SCOPE_DEDICATED_COORDINATOR_REQUIRED');
      return {rollback:async()=>{}}; // Existing static scope; no rotate/install/restart.

    },
    verifyWorker: async () => verify(assignment, target.root),
    activateBinding: async () => activate(assignment),
    complete: async ({ assignment: value }) => completeProjectWorkerAssignment({ projectId: value.project_id, deploymentId, leaseOwner: value.lease_owner! }),
    fail: async ({ assignment: value, error }) => failProjectWorkerAssignment({ projectId: value.project_id, deploymentId, leaseOwner: value.lease_owner!, error }),
    recoveryRequired: async ({ assignment: value, error }) => markProjectWorkerAssignmentRecoveryRequired({ projectId: value.project_id, deploymentId, leaseOwner: value.lease_owner!, error }),
  });
  console.log(JSON.stringify({ status: result.ok ? 'active' : 'failed', projectId: assignment.project_id, workerId,
    sharedStorageVerification: result.ok && storageVerification.status === 'required' ? 'verified' : 'unverified',
    ...(storageVerification.status === 'unverified' ? { sharedStorageReason: storageVerification.reason } : {}),
    ...(result.ok ? {} : { error: result.error }) }));
  if (!result.ok) process.exitCode = 1;
}

main()
  .catch(error => { console.error(JSON.stringify({ status: 'error', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; })
  .finally(() => closePgPool());
