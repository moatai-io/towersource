import { createHash } from 'node:crypto';

/** Metadata-only evidence supplied by trusted storage collectors, never a client authorization. */
export interface StorageSnapshot {
  projectId: string;
  deploymentId: string;
  source: { kind: 'host' | 'worker'; workerId: string | null };
  scope: 'project-root';
  complete: boolean;
  capturedAt: number;
  entries: Array<{ path: string; type: 'file' | 'directory'; sizeBytes?: number; sha256?: string }>;
}
export interface StoragePreflightInput {
  projectId: string;
  deploymentId: string;
  target: StorageSnapshot['source'];
  host: StorageSnapshot;
  worker: StorageSnapshot;
  now: number;
}

function indexSnapshot(snapshot: StorageSnapshot, input: StoragePreflightInput) {
  if (snapshot.projectId !== input.projectId || snapshot.deploymentId !== input.deploymentId) throw new Error('STORAGE_EVIDENCE_SCOPE_MISMATCH');
  if (snapshot.scope !== 'project-root' || !snapshot.complete) throw new Error('STORAGE_EVIDENCE_INCOMPLETE');
  if (!Number.isFinite(snapshot.capturedAt) || snapshot.capturedAt > input.now || input.now - snapshot.capturedAt > 60_000) throw new Error('STORAGE_EVIDENCE_STALE');
  const entries = new Map<string, StorageSnapshot['entries'][number]>();
  for (const entry of snapshot.entries) {
    const parts = entry.path.split('/');
    if (!entry.path || entry.path.includes('\\') || entry.path.includes('\0') || parts.some(part => !part || part === '.' || part === '..') || entries.has(entry.path)) throw new Error('STORAGE_MANIFEST_PATH_INVALID');
    if (entry.type !== 'file' && entry.type !== 'directory') throw new Error('STORAGE_MANIFEST_TYPE_INVALID');
    if (entry.type === 'file' && (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes! < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? ''))) throw new Error('STORAGE_MANIFEST_HASH_REQUIRED');
    entries.set(entry.path, entry);
  }
  for (const name of entries.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (entries.get(parts.slice(0, i).join('/'))?.type === 'file') throw new Error('STORAGE_MANIFEST_PATH_INVALID');
    }
  }
  return entries;
}

/** No DB writes, file reads, authority switches or ready claims. Equal bytes are not mount proof. */
export function planProjectFileStoragePreflight(input: StoragePreflightInput) {
  if (!input.projectId || !input.deploymentId || !Number.isFinite(input.now)) throw new Error('STORAGE_PREFLIGHT_INPUT_INVALID');
  if (input.host.source.kind !== 'host' || input.host.source.workerId !== null
    || input.worker.source.kind !== 'worker' || !input.worker.source.workerId?.trim()) throw new Error('STORAGE_EVIDENCE_IDENTITY_INVALID');
  if ((input.target.kind === 'host' && input.target.workerId !== null)
    || (input.target.kind === 'worker' && input.target.workerId !== input.worker.source.workerId)
    || !['host', 'worker'].includes(input.target.kind)) throw new Error('STORAGE_TARGET_MISMATCH');
  const host = indexSnapshot(input.host, input);
  const worker = indexSnapshot(input.worker, input);
  const differences: Array<{ path: string; reason: 'host-only' | 'worker-only' | 'type-conflict' | 'content-conflict' }> = [];
  const paths = [...new Set([...host.keys(), ...worker.keys()])].sort();
  for (const path of paths) {
    const a = host.get(path); const b = worker.get(path);
    if (!a) differences.push({ path, reason: 'worker-only' });
    else if (!b) differences.push({ path, reason: 'host-only' });
    else if (a.type !== b.type) differences.push({ path, reason: 'type-conflict' });
    else if (a.type === 'file' && (a.sha256 !== b.sha256 || a.sizeBytes !== b.sizeBytes)) differences.push({ path, reason: 'content-conflict' });
  }
  const canonical = (snapshot: StorageSnapshot) => ({ ...snapshot, entries: [...snapshot.entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });
  const evidenceHash = createHash('sha256').update(JSON.stringify({ projectId: input.projectId, deploymentId: input.deploymentId, target: input.target, host: canonical(input.host), worker: canonical(input.worker) })).digest('hex');
  return {
    status: differences.length ? 'reconciliation-required' as const : 'content-matched' as const,
    differences, evidenceHash, target: input.target,
    // Not an approval token or a storage-ready result. Collectors must be trusted and
    // evidence must be revalidated under write exclusion immediately before cutover.
    readyToActivate: false as const,
    remainingChecks: ['trusted-collector-provenance', 'execution-mount-roundtrip', 'current-access-check', 'write-exclusion-and-revalidation', 'explicit-cutover-approval'],
  };
}
