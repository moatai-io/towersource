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
import { getPersistedWorkbenchWorker } from '../services/runtime-box/workbench-worker-repository.js';
import { getWorkbenchWorkerIdentity, rotateWorkbenchWorkerIdentity } from '../services/runtime-box/workbench-worker-identity-repository.js';
import { resolveWorkbenchWorkerTransportToken } from '../services/runtime-box/workbench-worker-transport-credentials.js';
import { query, queryOne, transaction } from '../db/pg-repo.js';
import {
  claimProjectWorkerAssignment, completeProjectWorkerAssignment, failProjectWorkerAssignment, markProjectWorkerAssignmentRecoveryRequired,
  type ProjectWorkerAssignmentDesire,
} from '../services/runtime-box/workbench-project-worker-assignment.js';
import { reconcileClaimedProjectWorkerAssignment } from '../services/runtime-box/workbench-project-worker-assignment-reconciler.js';

const run = promisify(execFile);
const deploymentId = process.env.TOWER_ASSIGNMENT_DEPLOYMENT_ID?.trim() || 'production';
const workerId = process.env.TOWER_ASSIGNMENT_PRIMARY_WORKER_ID?.trim() || 'tower-prod-local-01';
const configFile = process.env.TOWER_ASSIGNMENT_WORKER_CONFIG?.trim() || path.join(process.env.HOME!, '.config/tower-workers', `${workerId}.json`);
const identityFile = process.env.TOWER_ASSIGNMENT_WORKER_IDENTITY?.trim() || path.join(process.env.HOME!, '.config/tower-workers', `${workerId}.identity.jwt`);
const installer = process.env.TOWER_ASSIGNMENT_WORKER_INSTALLER?.trim();
const workerUnit = process.env.TOWER_ASSIGNMENT_WORKER_UNIT?.trim() || 'tower-prod-workbench-worker.service';
const heartbeatUnit = process.env.TOWER_ASSIGNMENT_HEARTBEAT_UNIT?.trim() || 'tower-prod-workbench-worker-heartbeat.service';
const workspaceRoot = path.resolve(process.env.WORKSPACE_ROOT || '/home/tower/workspace');
const maxRuns = process.env.TOWER_ASSIGNMENT_PRIMARY_MAX_RUNS?.trim() || '5';
const actorUserId = Number(process.env.TOWER_ASSIGNMENT_ACTOR_USER_ID || 1);

function requiredFiles(): void {
  if (!installer || !path.isAbsolute(installer) || !fs.existsSync(installer)) throw new Error('TOWER_ASSIGNMENT_WORKER_INSTALLER_REQUIRED');
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

function atomicWrite(file: string, content: string, mode: number): void {
  const temp = `${file}.assignment-${process.pid}`;
  fs.writeFileSync(temp, content, { mode });
  fs.renameSync(temp, file);
  fs.chmodSync(file, mode);
}

async function rotateIdentity(projects: Record<string, string>, reason: string): Promise<void> {
  const active = await query<any>(`SELECT jti FROM runtime_box_workbench_worker_identities WHERE worker_id=$1 AND revoked_at IS NULL AND expires_at>NOW() ORDER BY issued_at DESC`, [workerId]);
  if (active.length !== 1) throw new Error(`PRIMARY_ACTIVE_IDENTITY_COUNT:${active.length}`);
  const issued = issueWorkbenchWorkerIdentity({ workerId, projectIds: Object.keys(projects), capabilities: ['job', 'service', 'shell'], expiresIn: '30d' });
  await rotateWorkbenchWorkerIdentity({ previousJti: active[0].jti, replacement: issued.identity, issuedByUserId: actorUserId, reason });
  atomicWrite(identityFile, `${issued.token}\n`, 0o600);
}

async function installAndRestart(projects: Record<string, string>): Promise<void> {
  atomicWrite(configFile, `${JSON.stringify({ workerId, host: '127.0.0.1', port: 43325, projects }, null, 2)}\n`, 0o644);
  await run(installer!, [], { env: {
    ...process.env,
    TOWER_LOCAL_WORKER_ID: workerId,
    TOWER_LOCAL_WORKER_PROJECT_IDS: Object.keys(projects).join(','),
    TOWER_LOCAL_WORKER_READ_WRITE_PATHS: Object.values(projects).join(' '),
    TOWER_LOCAL_WORKER_BASE_URL: 'http://127.0.0.1:43325',
    TOWER_LOCAL_WORKER_MAX_RUNS: maxRuns,
  }});
  await run('systemctl', ['--user', 'restart', workerUnit, heartbeatUnit]);
}

async function verify(assignment: ProjectWorkerAssignmentDesire, root: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const worker = await getPersistedWorkbenchWorker(workerId);
    if (worker?.status === 'healthy' && worker.projectIds.includes(assignment.project_id) && worker.capacity.maxRuns === Number(maxRuns)) break;
    if (attempt === 29) throw new Error('PRIMARY_WORKER_HEARTBEAT_SCOPE_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const token = await resolveWorkbenchWorkerTransportToken(workerId, actorUserId);
  if (!token) throw new Error('PRIMARY_WORKER_TRANSPORT_UNAVAILABLE');
  const response = await fetch('http://127.0.0.1:43325/v1/runs', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ spec: { jobId: 990000000 + Math.floor(Math.random() * 1000000), projectId: assignment.project_id, command: `test \"$(pwd)\" = ${JSON.stringify(root)} && printf assignment-smoke-ok`, timeoutSec: 30, environmentKeys: [], artifacts: [] }, credentials: {} }) });
  if (!response.ok || !(await response.text()).includes('assignment-smoke-ok')) throw new Error('PRIMARY_WORKER_ASSIGNMENT_SMOKE_FAILED');
}

async function activate(assignment: ProjectWorkerAssignmentDesire): Promise<void> {
  await transaction(async client => {
    const current = await client.query(`SELECT status,lease_owner FROM project_worker_assignment_desires WHERE project_id=$1 AND deployment_id=$2 FOR UPDATE`, [assignment.project_id, deploymentId]);
    if (current.rows[0]?.status !== 'preparing' || current.rows[0]?.lease_owner !== assignment.lease_owner) throw new Error('ASSIGNMENT_LEASE_LOST');
    await client.query(`INSERT INTO project_compute_deployment_bindings(project_id,deployment_id,default_worker_id,workstation_mode,authority_mode,updated_by_user_id) VALUES($1,$2,$3,TRUE,'project',$4) ON CONFLICT(project_id,deployment_id) DO UPDATE SET default_worker_id=EXCLUDED.default_worker_id,workstation_mode=TRUE,authority_mode='project',updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=NOW()`, [assignment.project_id, deploymentId, workerId, actorUserId]);
  });
}

async function main(): Promise<void> {
  requiredFiles();
  const assignment = await claimProjectWorkerAssignment({ deploymentId, owner: `host:${process.pid}`, leaseSeconds: 180 });
  if (!assignment) return void console.log(JSON.stringify({ status: 'idle' }));
  const target = await project(assignment.project_id);
  const originalConfig = JSON.parse(fs.readFileSync(configFile, 'utf8')) as { projects: Record<string, string> };
  const nextProjects = { ...originalConfig.projects, [assignment.project_id]: target.root };
  const result = await reconcileClaimedProjectWorkerAssignment(assignment, {
    prepareWorker: async () => {
      await rotateIdentity(nextProjects, `Automatic primary assignment ${assignment.project_id}`);
      await installAndRestart(nextProjects);
      return { rollback: async () => { await rotateIdentity(originalConfig.projects, `Rollback failed assignment ${assignment.project_id}`); await installAndRestart(originalConfig.projects); } };
    },
    verifyWorker: async () => verify(assignment, target.root),
    activateBinding: async () => activate(assignment),
    complete: async ({ assignment: value }) => completeProjectWorkerAssignment({ projectId: value.project_id, deploymentId, leaseOwner: value.lease_owner! }),
    fail: async ({ assignment: value, error }) => failProjectWorkerAssignment({ projectId: value.project_id, deploymentId, leaseOwner: value.lease_owner!, error }),
    recoveryRequired: async ({ assignment: value, error }) => markProjectWorkerAssignmentRecoveryRequired({ projectId: value.project_id, deploymentId, leaseOwner: value.lease_owner!, error }),
  });
  console.log(JSON.stringify({ status: result.ok ? 'active' : 'failed', projectId: assignment.project_id, workerId, ...(result.ok ? {} : { error: result.error }) }));
  if (!result.ok) process.exitCode = 1;
}

main().catch(error => { console.error(JSON.stringify({ status: 'error', error: error instanceof Error ? error.message : String(error) })); process.exit(1); });
