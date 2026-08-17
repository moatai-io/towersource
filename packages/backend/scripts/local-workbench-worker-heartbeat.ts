#!/usr/bin/env node
/**
 * Owns: same-VM Worker registration and heartbeat over the normal Worker identity API.
 * Public API: CLI configured by TOWER_LOCAL_WORKER_* environment variables.
 */

import fs from 'node:fs';

const workerId = process.env.TOWER_LOCAL_WORKER_ID?.trim();
const baseUrl = process.env.TOWER_LOCAL_WORKER_BASE_URL?.trim();
const deploymentId = process.env.TOWER_LOCAL_WORKER_DEPLOYMENT_ID?.trim()
  || process.env.TOWER_DEPLOYMENT_ID?.trim()
  || (process.env.NODE_ENV === 'production' ? 'production' : 'development');
const controlPlaneUrl = process.env.TOWER_LOCAL_WORKER_CONTROL_PLANE_URL?.trim();
const identityFile = process.env.TOWER_LOCAL_WORKER_IDENTITY_FILE?.trim();
const projectIds = (process.env.TOWER_LOCAL_WORKER_PROJECT_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean);
const capabilities = (process.env.TOWER_LOCAL_WORKER_CAPABILITIES ?? 'job,service,shell').split(',').map(value => value.trim()).filter(Boolean);
const intervalMs = Math.max(2_000, Number(process.env.TOWER_LOCAL_WORKER_HEARTBEAT_MS ?? 5_000));
const maxRuns = Number(process.env.TOWER_LOCAL_WORKER_MAX_RUNS ?? 4);
if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 1_000) {
  throw new Error('TOWER_LOCAL_WORKER_MAX_RUNS must be an integer between 1 and 1000');
}

if (!workerId || !baseUrl || !controlPlaneUrl || !identityFile || projectIds.length === 0) {
  throw new Error('TOWER_LOCAL_WORKER_ID, BASE_URL, CONTROL_PLANE_URL, IDENTITY_FILE, and PROJECT_IDS are required');
}
const token = fs.readFileSync(identityFile, 'utf8').trim();
if (!token) throw new Error('Worker identity token file is empty');
const capacity = { cpuTotal: 4, memoryMbTotal: 8192, activeRuns: 0, maxRuns };

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${controlPlaneUrl!.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Worker control plane ${path} failed: ${response.status}`);
}

async function register(): Promise<void> {
  await post('/api/workbench-workers/register', { workerId, deploymentId, baseUrl, capabilities, projectIds, capacity });
}

async function heartbeat(): Promise<void> {
  await post('/api/workbench-workers/heartbeat', { workerId, capacity });
}

await register();
console.log(`[local-worker-heartbeat] registered worker=${workerId} deployment=${deploymentId}`);
setInterval(() => {
  void heartbeat().catch(async error => {
    console.error(`[local-worker-heartbeat] heartbeat failed: ${(error as Error).message}`);
    try { await register(); }
    catch (registerError) { console.error(`[local-worker-heartbeat] re-register failed: ${(registerError as Error).message}`); }
  });
}, intervalMs);
