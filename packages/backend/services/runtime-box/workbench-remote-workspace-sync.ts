/**
 * Owns: Conflict-safe workspace materialization around one Remote Workbench Job.
 * Public API: snapshotWorkspace, applyRemoteWorkspaceDelta, RemoteWorkspaceSnapshot.
 *
 * Remote output is staged outside the Project first. Files are applied only when the
 * Tower-side file still matches the dispatch snapshot. Deletes and hidden paths are
 * intentionally unsupported in the first slice.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface RemoteWorkspaceSnapshot {
  projectRoot: string;
  files: Record<string, string>;
}

export interface RemoteWorkspaceApplyResult {
  applied: string[];
  unchanged: string[];
  conflicts: string[];
}

const IGNORED_SEGMENTS = new Set(['.git', '.tower', '.project', 'node_modules']);

function safeRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) throw new Error('REMOTE_WORKSPACE_PATH_INVALID');
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || IGNORED_SEGMENTS.has(part))) {
    throw new Error(`REMOTE_WORKSPACE_PATH_FORBIDDEN: ${value}`);
  }
  return parts.join('/');
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    if (IGNORED_SEGMENTS.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) output.push(...await walkFiles(root, absolute));
    else if (entry.isFile()) output.push(path.relative(root, absolute).replaceAll(path.sep, '/'));
  }
  return output;
}

/** Capture hashes used both for input provenance and optimistic output conflict checks. */
export async function snapshotWorkspace(projectRoot: string): Promise<RemoteWorkspaceSnapshot> {
  const root = path.resolve(projectRoot);
  const files: Record<string, string> = {};
  for (const relative of await walkFiles(root)) files[relative] = await sha256(path.join(root, relative));
  return { projectRoot: root, files };
}

/** Apply staged Worker output without overwriting files changed on Tower after dispatch. */
export async function applyRemoteWorkspaceDelta(input: {
  snapshot: RemoteWorkspaceSnapshot;
  stagedRoot: string;
}): Promise<RemoteWorkspaceApplyResult> {
  const stagedRoot = path.resolve(input.stagedRoot);
  const result: RemoteWorkspaceApplyResult = { applied: [], unchanged: [], conflicts: [] };
  for (const rawRelative of await walkFiles(stagedRoot)) {
    const relative = safeRelativePath(rawRelative);
    const stagedPath = path.join(stagedRoot, relative);
    const remoteHash = await sha256(stagedPath);
    const baselineHash = input.snapshot.files[relative];
    if (remoteHash === baselineHash) {
      result.unchanged.push(relative);
      continue;
    }
    const target = path.join(input.snapshot.projectRoot, relative);
    let currentHash: string | undefined;
    try { currentHash = await sha256(target); } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (currentHash !== baselineHash) {
      result.conflicts.push(relative);
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tower-remote-${process.pid}.tmp`;
    await fs.copyFile(stagedPath, temporary);
    await fs.rename(temporary, target);
    result.applied.push(relative);
  }
  if (result.conflicts.length > 0) {
    throw Object.assign(new Error(`REMOTE_WORKSPACE_CONFLICT: ${result.conflicts.join(', ')}`), { result });
  }
  return result;
}
