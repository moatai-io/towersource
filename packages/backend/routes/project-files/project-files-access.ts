/**
 * Owns: compatibility between the legacy coarse workspace root and Project ACLs.
 * Public API: isPathAllowedByCoarseRootOrAcl. See README.md.
 */
import { isPathSafe } from '../../services/workspace/file-system.js';
import { isPathAccessible } from '../../services/pm/project-access.js';

/** Allow a path inside the coarse root or one granted by the active Project ACL. */
export async function isPathAllowedByCoarseRootOrAcl(targetPath: string, userRoot: string, userId: number | undefined, role: string | undefined): Promise<boolean> {
  if (isPathSafe(targetPath, userRoot)) return true;
  if (userId && await isPathAccessible(targetPath, userId, role || 'member')) return true;
  return false;
}
