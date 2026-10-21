import type { StorageSnapshot } from './project-file-storage-preflight.js';
import { planProjectFileStoragePreflight } from './project-file-storage-preflight.js';
import { getPersistedWorkbenchWorker } from '../execution/worker/worker-repository.js';
import { resolveWorkbenchWorkerTransportToken } from '../execution/worker/worker-transport-credentials.js';

/** Internal maintenance API; caller checks current Agent access before invoking. */
export async function collectWorkerStorageSnapshot(input: { projectId: string; deploymentId: string; workerId: string; actorUserId: number }): Promise<StorageSnapshot> {
  const worker = await getPersistedWorkbenchWorker(input.workerId);
  if (!worker || worker.status !== 'healthy' || worker.deploymentId !== input.deploymentId || !worker.projectIds.includes(input.projectId)) throw new Error('STORAGE_WORKER_AUTHORITY_UNAVAILABLE');
  const token = await resolveWorkbenchWorkerTransportToken(input.workerId, input.actorUserId);
  if (!token) throw new Error('STORAGE_WORKER_TOKEN_MISSING');
  const url = new URL(`/v1/files/${encodeURIComponent(input.projectId)}/manifest`, worker.baseUrl);
  url.searchParams.set('path', '.'); url.searchParams.set('mode', 'storage-preflight-v1');
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!response.ok) throw new Error(`STORAGE_WORKER_SNAPSHOT_HTTP_${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('STORAGE_WORKER_SNAPSHOT_EMPTY');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('STORAGE_WORKER_SNAPSHOT_LIMIT'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (data.schemaVersion !== 'storage-preflight-v1' || data.projectId !== input.projectId || data.complete !== true || !Array.isArray(data.entries) || data.entries.length > 2000) throw new Error('STORAGE_WORKER_SNAPSHOT_CONTRACT');
  const snapshot: StorageSnapshot = { projectId: input.projectId, deploymentId: input.deploymentId, source: { kind: 'worker', workerId: input.workerId }, scope: 'project-root', complete: true, capturedAt: data.capturedAt, entries: data.entries };
  // Reuse strict manifest validation. This comparison is validation only, not host evidence.
  planProjectFileStoragePreflight({ ...input, target: snapshot.source, worker: snapshot, host: { ...snapshot, source: { kind: 'host', workerId: null } }, now: Date.now() });
  return snapshot;
}
