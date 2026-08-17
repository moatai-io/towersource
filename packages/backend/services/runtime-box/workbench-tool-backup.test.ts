import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stableManifestHash, stableManifestJson, type WorkbenchToolManifest } from './workbench-tools.js';

const mocks = vi.hoisted(() => ({ queryOne: vi.fn(), storeRoot: '' }));
vi.mock('../../db/pg-repo.js', () => ({ queryOne: mocks.queryOne }));
vi.mock('./workbench-tool-store.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./workbench-tool-store.js')>();
  return { ...actual, workbenchToolStoreRoot: () => mocks.storeRoot };
});

import { createWorkbenchActiveRevisionBackup, restoreWorkbenchActiveRevisionBackup } from './workbench-tool-backup.js';

const roots: string[] = [];
afterEach(() => {
  mocks.queryOne.mockReset();
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-backup-'));
  const backupPath = path.join(root, 'backup');
  const sourceStore = path.join(root, 'source-store');
  const targetStore = path.join(root, 'target-store');
  roots.push(root);
  mocks.storeRoot = sourceStore;
  const manifest: WorkbenchToolManifest = {
    schemaVersion: 1, workbenchId: 'source-project', revision: 4, createdAt: '2026-08-04T00:00:00.000Z',
    createdBy: { userId: 7, sessionId: 'session-1', jobId: 'command-1' }, manager: 'uv-tool',
    tools: [{ name: 'probe', version: '1.0.0', entrypoints: ['probe'], installSpec: 'probe==1.0.0' }],
    paths: { prefix: '.runtime-box/workbench-tools/revisions/000004', bin: '.runtime-box/workbench-tools/revisions/000004/bin' },
    validation: { status: 'passed', commands: [{ cmd: 'probe --version', exitCode: 0 }] }, previousRevision: 3, rollbackRef: null,
  };
  const hash = stableManifestHash(manifest);
  const revisionPath = path.join(sourceStore, 'projects', 'source-project', 'revisions', '000004');
  fs.mkdirSync(path.join(revisionPath, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(revisionPath, 'bin', 'probe'), '#!/bin/sh\necho probe-1.0.0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(revisionPath, 'manifest.json'), stableManifestJson(manifest));
  mocks.queryOne.mockResolvedValue({
    current_revision: 4, health: 'healthy', state: 'active', manifest, manifest_hash: hash,
    validation: manifest.validation, reason: 'install', storage_kind: 'tower-managed-v1',
    store_ref: 'projects/source-project/revisions/000004', store_manifest_hash: hash,
  });
  return { root, backupPath, sourceStore, targetStore, manifest, hash };
}

describe('Workbench active revision backup/restore', () => {
  it('backs up only the verified active payload and restores it under a new Project identity', async () => {
    const item = fixture();
    const metadata = await createWorkbenchActiveRevisionBackup({ projectId: 'source-project', backupPath: item.backupPath, storeRoot: item.sourceStore });
    expect(metadata).toMatchObject({
      sourceProjectId: 'source-project', activeRevision: 4,
      includes: ['active-revision-metadata', 'manifest', 'immutable-payload'],
      excludes: ['credentials', 'project-files', 'cache', 'command-history', 'inactive-revisions'],
    });
    const restored = await restoreWorkbenchActiveRevisionBackup({ backupPath: item.backupPath, targetProjectId: 'restored-project', targetStoreRoot: item.targetStore });
    expect(restored.stateRow).toEqual({ projectId: 'restored-project', currentRevision: 1, health: 'healthy', storageMode: 'tower-managed-v1' });
    expect(restored.revisionRow).toMatchObject({ projectId: 'restored-project', revision: 1, state: 'active', storageKind: 'tower-managed-v1' });
    expect(restored.revisionRow.manifest).toMatchObject({ workbenchId: 'restored-project', revision: 1, previousRevision: null });
    expect(fs.readFileSync(path.join(restored.revisionPath, 'bin', 'probe'), 'utf8')).toContain('probe-1.0.0');
  });

  it('rejects a tampered backup before creating a restored revision', async () => {
    const item = fixture();
    await createWorkbenchActiveRevisionBackup({ projectId: 'source-project', backupPath: item.backupPath, storeRoot: item.sourceStore });
    fs.writeFileSync(path.join(item.backupPath, 'payload', 'manifest.json'), '{}\n');
    await expect(restoreWorkbenchActiveRevisionBackup({ backupPath: item.backupPath, targetProjectId: 'restored-project', targetStoreRoot: item.targetStore }))
      .rejects.toMatchObject({ code: 'BACKUP_HASH_MISMATCH' });
    expect(fs.existsSync(path.join(item.targetStore, 'projects', 'restored-project'))).toBe(false);
  });

  it('refuses recovery_required or divergent active metadata', async () => {
    const item = fixture();
    mocks.queryOne.mockResolvedValue({
      current_revision: 4, health: 'recovery_required', state: 'active', manifest: item.manifest,
      manifest_hash: item.hash, validation: {}, reason: 'install', storage_kind: 'tower-managed-v1',
      store_ref: 'projects/source-project/revisions/000004', store_manifest_hash: item.hash,
    });
    await expect(createWorkbenchActiveRevisionBackup({ projectId: 'source-project', backupPath: item.backupPath, storeRoot: item.sourceStore }))
      .rejects.toMatchObject({ code: 'ACTIVE_REVISION_NOT_BACKUP_SAFE' });
  });
});
