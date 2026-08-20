#!/usr/bin/env node
/**
 * Owns: FK-safe bootstrap/rotation of one system Workbench Worker identity and transport credential.
 * Public API: CLI configured by TOWER_BOOTSTRAP_WORKER_* environment variables.
 *
 * Writes short-lived credential artifacts only to the operator-provided staging directory.
 * The caller must install them into a protected location and remove the staging directory.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { query } from '../db/pg-repo.js';
import { issueWorkbenchWorkerIdentity } from '../services/runtime-box/workbench-worker-identity.js';
import {
  recordWorkbenchWorkerIdentity,
  rotateWorkbenchWorkerIdentity,
} from '../services/runtime-box/workbench-worker-identity-repository.js';
import { upsertWorkbenchWorker } from '../services/runtime-box/workbench-worker-repository.js';
import { configureWorkbenchWorkerTransportCredential } from '../services/runtime-box/workbench-worker-transport-credentials.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const workerId = required('TOWER_BOOTSTRAP_WORKER_ID');
const projectId = required('TOWER_BOOTSTRAP_PROJECT_ID');
const projectRoot = path.resolve(required('TOWER_BOOTSTRAP_PROJECT_ROOT'));
const stage = path.resolve(required('TOWER_BOOTSTRAP_STAGE_DIR'));
const deploymentId = process.env.TOWER_BOOTSTRAP_DEPLOYMENT_ID?.trim() || 'development';
const host = process.env.TOWER_BOOTSTRAP_WORKER_HOST?.trim() || '127.0.0.1';
const port = Number(required('TOWER_BOOTSTRAP_WORKER_PORT'));
const actorUserId = Number(required('TOWER_BOOTSTRAP_ACTOR_USER_ID'));
const maxRuns = Number(process.env.TOWER_BOOTSTRAP_MAX_RUNS?.trim() || '4');
const authorityMode = process.env.TOWER_BOOTSTRAP_AUTHORITY_MODE?.trim() || 'project';
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('TOWER_BOOTSTRAP_WORKER_PORT is invalid');
if (!Number.isSafeInteger(actorUserId) || actorUserId < 1) throw new Error('TOWER_BOOTSTRAP_ACTOR_USER_ID is invalid');
if (!Number.isInteger(maxRuns) || maxRuns < 3 || maxRuns > 1000) throw new Error('TOWER_BOOTSTRAP_MAX_RUNS must be between 3 and 1000 capacity units');
if (!['project', 'operator-plane'].includes(authorityMode)) throw new Error('TOWER_BOOTSTRAP_AUTHORITY_MODE is invalid');
const stageStat = fs.statSync(stage);
if (!stageStat.isDirectory()) throw new Error('TOWER_BOOTSTRAP_STAGE_DIR must be a directory');

const capabilities = ['job', 'service', 'shell', ...(authorityMode === 'operator-plane' ? ['operator-plane'] : [])];
const issued = issueWorkbenchWorkerIdentity({ workerId, projectIds: [projectId], capabilities, expiresIn: '7d' });
const active = await query<{ jti: string }>(
  `SELECT jti FROM runtime_box_workbench_worker_identities
   WHERE worker_id=$1 AND revoked_at IS NULL AND expires_at>NOW() ORDER BY issued_at DESC`,
  [workerId],
);
if (active.length > 1) throw new Error(`ACTIVE_WORKER_IDENTITY_COUNT:${active.length}`);
if (active.length === 1) {
  await rotateWorkbenchWorkerIdentity({
    previousJti: active[0].jti,
    replacement: issued.identity,
    issuedByUserId: actorUserId,
    reason: 'system Worker credential bootstrap rotation',
  });
} else {
  await recordWorkbenchWorkerIdentity({
    identity: issued.identity,
    issuedByUserId: actorUserId,
    reason: 'system Worker credential bootstrap',
  });
}

// The transport binding has a Worker registry FK, so registration must precede credential configuration.
await upsertWorkbenchWorker({
  workerId,
  deploymentId,
  baseUrl: `http://${host}:${port}`,
  capabilities,
  projectIds: [projectId],
  capacity: { cpuTotal: 4, memoryMbTotal: 8192, activeRuns: 0, maxRuns },
});
const transport = crypto.randomBytes(48).toString('base64url');
await configureWorkbenchWorkerTransportCredential({ workerId, token: transport, actorUserId });

const operatorTowerSource = process.env.TOWER_BOOTSTRAP_OPERATOR_TOWER_SOURCE?.trim();
const operatorWorkspaceRoot = process.env.TOWER_BOOTSTRAP_OPERATOR_WORKSPACE_ROOT?.trim();
const operatorGitName = process.env.TOWER_BOOTSTRAP_OPERATOR_GIT_AUTHOR_NAME?.trim();
const operatorGitEmail = process.env.TOWER_BOOTSTRAP_OPERATOR_GIT_AUTHOR_EMAIL?.trim();
if (authorityMode === 'operator-plane' && (!operatorTowerSource || !operatorWorkspaceRoot)) {
  throw new Error('Operator Worker requires Tower source and workspace projection roots');
}
if ((operatorGitName && !operatorGitEmail) || (!operatorGitName && operatorGitEmail)) {
  throw new Error('Operator Git identity requires both name and email');
}
const config = {
  workerId, host, port, projects: { [projectId]: projectRoot },
  ...(authorityMode === 'operator-plane' ? { projections: {
    '/workspace/tower': path.resolve(operatorTowerSource!),
    '/workspace/workspace': path.resolve(operatorWorkspaceRoot!),
  } } : {}),
  ...(operatorGitName && operatorGitEmail ? { operatorGitIdentity: { name: operatorGitName, email: operatorGitEmail } } : {}),
};
fs.writeFileSync(path.join(stage, `${workerId}.json`), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(stage, `${workerId}.env`), `TOWER_REMOTE_WORKER_TOKEN=${transport}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(stage, `${workerId}.identity.jwt`), `${issued.token}\n`, { mode: 0o600 });
console.log(JSON.stringify({ status: 'staged', workerId, expiresAt: issued.identity.expiresAt }));
