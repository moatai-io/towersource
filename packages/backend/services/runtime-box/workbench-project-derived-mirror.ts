/**
 * Owns: best-effort host mirror updates for Worker-authoritative Project files.
 * Public API: mirrorWorkerProjectMutation.
 *
 * Worker storage remains authoritative. The host-shaped Project tree is retained as
 * a derived read model for legacy search, Notes Index, and Knowledge Graph scanners.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { WorkerFileAuthority } from './workbench-project-file-authority.js';

export type WorkerProjectMirrorMutation =
  | { kind: 'write-text'; hostPath: string; content: string }
  | { kind: 'upload'; hostPath: string; sourcePath: string }
  | { kind: 'mkdir'; hostPath: string }
  | { kind: 'delete'; hostPath: string }
  | { kind: 'rename'; oldHostPath: string; newHostPath: string }
  | { kind: 'copy'; sourceHostPath: string; targetHostPath: string };

function assertInsideProject(authority: WorkerFileAuthority, candidate: string): string {
  const root = path.resolve(authority.projectRoot);
  const resolved = path.resolve(candidate);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error('WORKER_DERIVED_MIRROR_PATH_OUTSIDE_PROJECT');
  }
  return resolved;
}

function applyMutation(authority: WorkerFileAuthority, mutation: WorkerProjectMirrorMutation): void {
  if (mutation.kind === 'write-text') {
    const target = assertInsideProject(authority, mutation.hostPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, mutation.content, 'utf8');
    return;
  }
  if (mutation.kind === 'upload') {
    const target = assertInsideProject(authority, mutation.hostPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(mutation.sourcePath, target);
    return;
  }
  if (mutation.kind === 'mkdir') {
    fs.mkdirSync(assertInsideProject(authority, mutation.hostPath), { recursive: true });
    return;
  }
  if (mutation.kind === 'delete') {
    fs.rmSync(assertInsideProject(authority, mutation.hostPath), { recursive: true, force: true });
    return;
  }
  if (mutation.kind === 'rename') {
    const source = assertInsideProject(authority, mutation.oldHostPath);
    const target = assertInsideProject(authority, mutation.newHostPath);
    if (!fs.existsSync(source)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(source, target);
    return;
  }
  const source = assertInsideProject(authority, mutation.sourceHostPath);
  const target = assertInsideProject(authority, mutation.targetHostPath);
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
}

/**
 * Update the host-derived read model without changing Worker mutation success.
 * Failures are logged because the mirror can be rebuilt from Worker authority.
 */
export function mirrorWorkerProjectMutation(
  authority: WorkerFileAuthority,
  mutation: WorkerProjectMirrorMutation,
): void {
  try {
    applyMutation(authority, mutation);
  } catch (error) {
    console.warn('[worker-project-derived-mirror] update failed', {
      projectId: authority.projectId,
      workerId: authority.workerId,
      kind: mutation.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
