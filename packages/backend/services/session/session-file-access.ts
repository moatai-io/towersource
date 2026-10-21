import path from 'node:path';
import { homedir } from 'node:os';
import { isDotfileDenied, isPathAccessible } from '../pm/project-access.js';

export interface SessionFileViewer { userId: number; role: string }

/** A session share does not grant file access. Recheck current ACL on every read.
 * Legacy relative paths have no trustworthy base here; omit rather than resolve
 * against the backend process cwd (which can point at a different Project).
 */
export async function filterAccessibleSessionFiles<T extends { file_path: string }>(
  rows: T[], viewer: SessionFileViewer,
): Promise<T[]> {
  const visible: T[] = [];
  for (const row of rows) {
    const target = row.file_path.startsWith('~/')
      ? path.join(homedir(), row.file_path.slice(2)) : row.file_path;
    if (!path.isAbsolute(target) || isDotfileDenied(target)) continue;
    if (await isPathAccessible(target, viewer.userId, viewer.role)) visible.push(row);
  }
  return visible;
}
