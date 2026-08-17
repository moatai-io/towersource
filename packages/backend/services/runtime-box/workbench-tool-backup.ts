// Owns: Minimal active Workbench revision backup/restore bundle.
// Public API: createWorkbenchActiveRevisionBackup, restoreWorkbenchActiveRevisionBackup.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { queryOne } from '../../db/pg-repo.js';
import {
  managedWorkbenchToolStoreRef,
  readAndVerifyManagedWorkbenchToolRevision,
  resolveManagedWorkbenchToolStoreLocation,
  workbenchToolStoreRoot,
} from './workbench-tool-store.js';
import { stableManifestHash, stableManifestJson, type WorkbenchToolManifest } from './workbench-tools.js';

export class WorkbenchBackupError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

interface ActiveRevisionRow {
  current_revision: number;
  health: 'healthy' | 'degraded' | 'recovery_required';
  state: 'active' | 'rollback';
  manifest: WorkbenchToolManifest;
  manifest_hash: string;
  validation: unknown;
  reason: string;
  storage_kind: 'tower-managed-v1';
  store_ref: string;
  store_manifest_hash: string;
}

export interface WorkbenchActiveRevisionBackupMetadata {
  schemaVersion: 1;
  sourceProjectId: string;
  activeRevision: number;
  state: 'active' | 'rollback';
  manifestHash: string;
  createdAt: string;
  includes: ['active-revision-metadata', 'manifest', 'immutable-payload'];
  excludes: ['credentials', 'project-files', 'cache', 'command-history', 'inactive-revisions'];
  revisionRecord: ActiveRevisionRow;
}

function ensureEmptyTarget(target: string): void {
  const resolved = path.resolve(target);
  if (fs.existsSync(resolved)) throw new WorkbenchBackupError('TARGET_EXISTS', 'Workbench backup/restore target already exists');
}

/** Copy the one DB-authoritative active revision into a self-contained verified bundle. */
export async function createWorkbenchActiveRevisionBackup(input: {
  projectId: string;
  backupPath: string;
  storeRoot?: string;
}): Promise<WorkbenchActiveRevisionBackupMetadata> {
  ensureEmptyTarget(input.backupPath);
  const row = await queryOne<ActiveRevisionRow>(
    `SELECT s.current_revision,s.health,r.state,r.manifest,r.manifest_hash,r.validation,r.reason,
            r.storage_kind,r.store_ref,r.store_manifest_hash
       FROM runtime_box_workbench_tool_states s
       JOIN runtime_box_workbench_tool_revisions r ON r.project_id=s.project_id AND r.revision=s.current_revision
      WHERE s.project_id=$1`, [input.projectId],
  );
  if (!row || row.health === 'recovery_required' || !['active', 'rollback'].includes(row.state)
    || row.storage_kind !== 'tower-managed-v1' || row.manifest_hash !== row.store_manifest_hash) {
    throw new WorkbenchBackupError('ACTIVE_REVISION_NOT_BACKUP_SAFE', 'Current Workbench revision is not a healthy finalized managed revision');
  }
  const verified = readAndVerifyManagedWorkbenchToolRevision({
    projectId: input.projectId, revision: Number(row.current_revision), storeRef: row.store_ref,
    expectedManifestHash: row.store_manifest_hash, storeRoot: input.storeRoot ?? workbenchToolStoreRoot(),
  });
  const metadata: WorkbenchActiveRevisionBackupMetadata = {
    schemaVersion: 1, sourceProjectId: input.projectId, activeRevision: Number(row.current_revision), state: row.state,
    manifestHash: row.manifest_hash, createdAt: new Date().toISOString(),
    includes: ['active-revision-metadata', 'manifest', 'immutable-payload'],
    excludes: ['credentials', 'project-files', 'cache', 'command-history', 'inactive-revisions'],
    revisionRecord: { ...row, current_revision: Number(row.current_revision) },
  };
  const target = path.resolve(input.backupPath);
  await fsp.mkdir(target, { recursive: false });
  try {
    await fsp.cp(verified.revisionPath, path.join(target, 'payload'), { recursive: true, dereference: false, preserveTimestamps: true });
    await fsp.writeFile(path.join(target, 'backup.json'), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    await fsp.rm(target, { recursive: true, force: true });
    throw error;
  }
  return metadata;
}

/** Restore one bundle as revision 1 for a new Project identity; caller persists returned rows transactionally. */
export async function restoreWorkbenchActiveRevisionBackup(input: {
  backupPath: string;
  targetProjectId: string;
  targetStoreRoot?: string;
}): Promise<{
  stateRow: { projectId: string; currentRevision: 1; health: 'healthy'; storageMode: 'tower-managed-v1' };
  revisionRow: {
    projectId: string; revision: 1; state: 'active'; manifest: WorkbenchToolManifest; manifestHash: string;
    prefixRelpath: string; validation: unknown; reason: string; storageKind: 'tower-managed-v1'; storeRef: string; storeManifestHash: string;
  };
  revisionPath: string;
}> {
  const backupRoot = path.resolve(input.backupPath);
  let metadata: WorkbenchActiveRevisionBackupMetadata;
  try { metadata = JSON.parse(await fsp.readFile(path.join(backupRoot, 'backup.json'), 'utf8')); }
  catch { throw new WorkbenchBackupError('BACKUP_METADATA_INVALID', 'Workbench backup metadata is unavailable'); }
  if (metadata.schemaVersion !== 1 || !metadata.revisionRecord || metadata.manifestHash !== metadata.revisionRecord.manifest_hash) {
    throw new WorkbenchBackupError('BACKUP_METADATA_INVALID', 'Workbench backup metadata is inconsistent');
  }
  const sourceManifest = metadata.revisionRecord.manifest;
  const sourceHash = stableManifestHash(sourceManifest);
  if (sourceHash !== metadata.manifestHash) throw new WorkbenchBackupError('BACKUP_HASH_MISMATCH', 'Workbench backup manifest hash mismatch');
  const payloadManifest = JSON.parse(await fsp.readFile(path.join(backupRoot, 'payload', 'manifest.json'), 'utf8')) as WorkbenchToolManifest;
  if (stableManifestHash(payloadManifest) !== sourceHash) throw new WorkbenchBackupError('BACKUP_HASH_MISMATCH', 'Workbench backup payload manifest differs from metadata');

  const manifest: WorkbenchToolManifest = {
    ...sourceManifest,
    workbenchId: input.targetProjectId,
    revision: 1,
    previousRevision: null,
    rollbackRef: null,
    paths: { prefix: '.runtime-box/workbench-tools/revisions/000001', bin: '.runtime-box/workbench-tools/revisions/000001/bin' },
    createdAt: new Date().toISOString(),
    createdBy: { userId: null, sessionId: null, jobId: null },
  };
  const manifestHash = stableManifestHash(manifest);
  const storeRef = managedWorkbenchToolStoreRef(input.targetProjectId, 1);
  const target = resolveManagedWorkbenchToolStoreLocation({
    projectId: input.targetProjectId, revision: 1, storeRef, storeRoot: input.targetStoreRoot ?? workbenchToolStoreRoot(),
  });
  ensureEmptyTarget(target.revisionPath);
  await fsp.mkdir(path.dirname(target.revisionPath), { recursive: true });
  try {
    await fsp.cp(path.join(backupRoot, 'payload'), target.revisionPath, { recursive: true, dereference: false, preserveTimestamps: true });
    await fsp.writeFile(target.manifestPath, stableManifestJson(manifest));
    readAndVerifyManagedWorkbenchToolRevision({
      projectId: input.targetProjectId, revision: 1, storeRef, expectedManifestHash: manifestHash,
      storeRoot: input.targetStoreRoot ?? workbenchToolStoreRoot(),
    });
  } catch (error) {
    await fsp.rm(target.revisionPath, { recursive: true, force: true });
    throw error;
  }
  return {
    stateRow: { projectId: input.targetProjectId, currentRevision: 1, health: 'healthy', storageMode: 'tower-managed-v1' },
    revisionRow: {
      projectId: input.targetProjectId, revision: 1, state: 'active', manifest, manifestHash,
      prefixRelpath: manifest.paths.prefix, validation: manifest.validation,
      reason: `restore:${metadata.sourceProjectId}:${metadata.activeRevision}`,
      storageKind: 'tower-managed-v1', storeRef, storeManifestHash: manifestHash,
    },
    revisionPath: target.revisionPath,
  };
}
