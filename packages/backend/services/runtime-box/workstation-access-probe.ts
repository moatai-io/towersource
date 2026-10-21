/** Read-only access probe. Must run as the intended execution identity/view.
 * fs.access uses real UID/GID: it cannot certify a child with different credentials.
 * No file contents are read, and no permission is changed.
 */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
export interface WorkstationAccessTarget {
  id: string;
  path: string;
  expected: 'read-write' | 'read-only' | 'inaccessible';
}
type AccessState = 'allowed' | 'denied' | 'missing' | 'unknown';
export async function probeWorkstationAccess(targets: WorkstationAccessTarget[]) {
  if (targets.length > 64) throw new Error('WORKSTATION_PROBE_LIMIT');
  const access = async (target: string, mode: number): Promise<AccessState> => {
    try { await fs.access(target, mode); return 'allowed'; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'EACCES' || code === 'EPERM') return 'denied';
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
      return 'unknown';
    }
  };
  return Promise.all(targets.map(async target => {
    const existence = await access(target.path, constants.F_OK);
    const read = await access(target.path, constants.R_OK);
    const write = await access(target.path, constants.W_OK);
    const parentWrite = await access(path.dirname(target.path), constants.W_OK | constants.X_OK);
    const unknown = [existence, read, write, parentWrite].includes('unknown');
    const missing = [existence, read, write, parentWrite].includes('missing');
    // Parent replacement can defeat readonly file modes. This remains a conservative
    // probe, not an ancestor/symlink/ACL/recursive security certification.
    const violates = target.expected === 'inaccessible'
      ? read === 'allowed' || write === 'allowed' || parentWrite === 'allowed'
      : target.expected === 'read-only'
        ? write === 'allowed' || parentWrite === 'allowed' || read === 'denied'
        : read === 'denied' || write === 'denied';
    const verdict = violates ? 'mismatch' as const
      : unknown || missing ? 'inconclusive' as const : 'pass' as const;
    return {
      id: target.id, expected: target.expected,
      access: { existence, read, write, parentWrite },
      coverage: 'access-only-not-recursive-or-symlink-safe' as const,
      verdict,
    };
  }));
}
