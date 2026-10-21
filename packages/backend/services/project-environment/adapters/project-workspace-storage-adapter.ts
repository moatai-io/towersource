import { createReadStream } from 'node:fs';
import { receiveWorkerProjectFileUpload } from '../../runtime-box/worker-project-file-upload.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileEntry } from '../../workspace/file-system.js';
import { getFileTreeAsync } from '../../workspace/file-system.js';
import {
  compareAndSwapCanonicalProjectText,
  copyCanonicalProjectEntry,
  createCanonicalProjectDirectory,
  deleteCanonicalProjectEntry,
  readCanonicalProjectFileBytes,
  readCanonicalProjectFileProbe,
  renameCanonicalProjectEntry,
  writeCanonicalProjectText,
} from './canonical-host-file-adapter.js';
import {
  compareAndSwapWorkerProjectFile,
  copyWorkerProjectEntry,
  createWorkerProjectDirectory,
  deleteWorkerProjectEntry,
  downloadWorkerProjectFile,
  statWorkerProjectFile,
  readWorkerProjectFileProbe,
  listWorkerProjectDirectory,
  renameWorkerProjectEntry,
  writeWorkerProjectFile,
  uploadWorkerProjectFile,
  workerProjectFileExists,
  type WorkerFileAuthority,
} from '../../runtime-box/workbench-project-file-authority.js';
import { mirrorWorkerProjectMutation } from '../../runtime-box/workbench-project-derived-mirror.js';

export interface ProjectWorkspaceStorageReference {
  projectId: string;
  projectRoot: string;
  relativePath: string;
  hostPath: string;
  workerAuthority?: WorkerFileAuthority;
}

export interface ProjectWorkspaceStorageAdapter {
  readonly kind: 'host' | 'worker';
  readonly workerId?: string;
  importExclusive(reference: ProjectWorkspaceStorageReference, actorUserId: number, sourcePath: string, sizeBytes: number, beforePublish?: () => Promise<void>): Promise<() => Promise<void>>;
  stat(reference: ProjectWorkspaceStorageReference, actorUserId: number): Promise<{ sizeBytes: number; version: string }>;
  exists(reference: ProjectWorkspaceStorageReference, actorUserId: number): Promise<boolean>;
  list(reference: ProjectWorkspaceStorageReference, actorUserId: number, showHidden?: boolean, depth?: number): Promise<FileEntry[]>;
  readProbe(reference: ProjectWorkspaceStorageReference, actorUserId: number, maxBytes: number): Promise<Buffer>;
  readBytes(reference: ProjectWorkspaceStorageReference, actorUserId: number, maxBytes: number): Promise<Buffer>;
  writeText(reference: ProjectWorkspaceStorageReference, actorUserId: number, content: string, exclusive?: boolean): Promise<void>;
  mkdir(reference: ProjectWorkspaceStorageReference, actorUserId: number, exclusive?: boolean): Promise<void>;
  remove(reference: ProjectWorkspaceStorageReference, actorUserId: number): Promise<void>;
  rename(source: ProjectWorkspaceStorageReference, target: ProjectWorkspaceStorageReference, actorUserId: number): Promise<void>;
  copy(source: ProjectWorkspaceStorageReference, targetDirectory: ProjectWorkspaceStorageReference, actorUserId: number): Promise<string>;
  compareAndSwapText(reference: ProjectWorkspaceStorageReference, actorUserId: number, expectedContent: string, content: string): Promise<void>;
}

const canonicalHostStorageAdapter: ProjectWorkspaceStorageAdapter = {
  kind: 'host',
  importExclusive: async (reference, _actorUserId, sourcePath, sizeBytes, beforePublish) => {
    await receiveWorkerProjectFileUpload({ target: reference.hostPath, expectedBytes: sizeBytes, chunks: createReadStream(sourcePath), exclusive: true, beforePublish });
    return () => fs.rm(reference.hostPath, { force: true });
  },
  readProbe: async (reference, _actorUserId, maxBytes) => readCanonicalProjectFileProbe(reference.projectRoot, reference.relativePath, maxBytes),
  stat: async reference => {
    const metadata = await fs.stat(reference.hostPath);
    if (!metadata.isFile()) throw new Error('PROJECT_WORKSPACE_FILE_NOT_FOUND');
    return { sizeBytes: metadata.size, version: `${metadata.size}:${metadata.mtimeMs}` };
  },
  exists: reference => hostEntryExists(reference),
  list: async (reference, _actorUserId, showHidden, depth = 2) => getFileTreeAsync(reference.hostPath, depth, { skipSafetyCheck: true, showHidden }),
  readBytes: async (reference, _actorUserId, maxBytes) => readCanonicalProjectFileBytes(reference.projectRoot, reference.relativePath, maxBytes),
  writeText: async (reference, _actorUserId, content, exclusive) => writeCanonicalProjectText(reference.projectRoot, reference.relativePath, content, exclusive),
  mkdir: async (reference, _actorUserId, exclusive) => createCanonicalProjectDirectory(reference.projectRoot, reference.relativePath, exclusive),
  remove: async (reference) => deleteCanonicalProjectEntry(reference.projectRoot, reference.relativePath),
  rename: async (source, target) => renameCanonicalProjectEntry(source.projectRoot, source.relativePath, target.relativePath),
  copy: async (source, targetDirectory) => {
    const relativeTarget = copyCanonicalProjectEntry(source.projectRoot, source.relativePath, targetDirectory.relativePath);
    return path.resolve(source.projectRoot, ...relativeTarget.split('/'));
  },
  compareAndSwapText: async (reference, _actorUserId, expectedContent, content) => compareAndSwapCanonicalProjectText(reference.projectRoot, reference.relativePath, expectedContent, content),
};

function legacyWorkerStorageAdapter(authority: WorkerFileAuthority): ProjectWorkspaceStorageAdapter {
  return {
    kind: 'worker',
    workerId: authority.workerId,
    importExclusive: async (reference, actorUserId, sourcePath, sizeBytes) => {
      if (await workerProjectFileExists({ authority: reference.workerAuthority!, actorUserId })) {
        throw Object.assign(new Error('PROJECT_WORKSPACE_FILE_EXISTS'), { code: 'EEXIST' });
      }
      await uploadWorkerProjectFile({ authority: reference.workerAuthority!, actorUserId, sourcePath, sizeBytes, exclusive: true });
      return () => deleteWorkerProjectEntry({ authority: reference.workerAuthority!, actorUserId });
    },
    stat: (reference, actorUserId) => statWorkerProjectFile({ authority: reference.workerAuthority!, actorUserId }),
    readProbe: (reference, actorUserId, maxBytes) => readWorkerProjectFileProbe({ authority: reference.workerAuthority!, actorUserId, maxBytes }),
    exists: async (reference, actorUserId) => {
      if (reference.relativePath === '.') return true;
      const relativePath = path.posix.dirname(reference.relativePath);
      const parent = { ...reference, relativePath, hostPath: path.dirname(reference.hostPath),
        workerAuthority: { ...reference.workerAuthority!, relativePath } };
      try {
        const entries = await listWorkerProjectDirectory({ authority: parent.workerAuthority, actorUserId, showHidden: true });
        return entries.some(entry => entry.name === path.posix.basename(reference.relativePath));
      } catch (error: any) {
        // A missing parent is a normal new-file case, never a permission bypass.
        if (error?.code === 'ENOENT' || /\bENOENT\b/.test(error?.message || '')) return false;
        throw error;
      }
    },
    list: async (reference, actorUserId, showHidden) => listWorkerProjectDirectory({ authority: reference.workerAuthority!, actorUserId, showHidden }),
    readBytes: async (reference, actorUserId, maxBytes) => downloadWorkerProjectFile({ authority: reference.workerAuthority!, actorUserId, maxBytes }),
    writeText: async (reference, actorUserId, content, exclusive) => {
      await writeWorkerProjectFile({ authority: reference.workerAuthority!, actorUserId, content, exclusive });
      mirrorWorkerProjectMutation(reference.workerAuthority!, { kind: 'write-text', hostPath: reference.hostPath, content });
    },
    mkdir: async (reference, actorUserId, exclusive) => {
      await createWorkerProjectDirectory({ authority: reference.workerAuthority!, actorUserId, exclusive });
      mirrorWorkerProjectMutation(reference.workerAuthority!, { kind: 'mkdir', hostPath: reference.hostPath });
    },
    remove: async (reference, actorUserId) => {
      await deleteWorkerProjectEntry({ authority: reference.workerAuthority!, actorUserId });
      mirrorWorkerProjectMutation(reference.workerAuthority!, { kind: 'delete', hostPath: reference.hostPath });
    },
    rename: async (source, target, actorUserId) => {
      await renameWorkerProjectEntry({ authority: source.workerAuthority!, actorUserId, newHostPath: target.hostPath });
      mirrorWorkerProjectMutation(source.workerAuthority!, { kind: 'rename', oldHostPath: source.hostPath, newHostPath: target.hostPath });
    },
    copy: async (source, targetDirectory, actorUserId) => {
      const copied = await copyWorkerProjectEntry({ authority: source.workerAuthority!, actorUserId, targetDirHostPath: targetDirectory.hostPath });
      mirrorWorkerProjectMutation(source.workerAuthority!, { kind: 'copy', sourceHostPath: source.hostPath, targetHostPath: copied.targetPath });
      return copied.targetPath;
    },
    compareAndSwapText: async (reference, actorUserId, expectedContent, content) => compareAndSwapWorkerProjectFile({
      authority: reference.workerAuthority!, actorUserId, expectedContent, content,
    }),
  };
}

export function projectWorkspaceStorageAdapter(reference: ProjectWorkspaceStorageReference): ProjectWorkspaceStorageAdapter {
  return reference.workerAuthority ? legacyWorkerStorageAdapter(reference.workerAuthority) : canonicalHostStorageAdapter;
}

export async function hostEntryExists(reference: ProjectWorkspaceStorageReference): Promise<boolean> {
  return fs.stat(reference.hostPath).then(() => true, error => error?.code === 'ENOENT' ? false : Promise.reject(error));
}

export interface ExpectedProjectWorkspaceStorage {
  kind: 'host' | 'worker';
  workerId?: string | null;
}

export function assertExpectedStorage(reference: ProjectWorkspaceStorageReference, expected?: ExpectedProjectWorkspaceStorage): void {
  if (!expected) return;
  const actualKind = reference.workerAuthority ? 'worker' : 'host';
  if (actualKind !== expected.kind || (reference.workerAuthority && reference.workerAuthority.workerId !== expected.workerId)) {
    throw new Error('WORKSPACE_STORAGE_CHANGED');
  }
}
