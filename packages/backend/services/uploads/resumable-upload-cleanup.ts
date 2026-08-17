/**
 * Owns: cleanup of expired resumable upload staging directories.
 * Public API: cleanupExpiredResumableUploads().
 * See README.md.
 */

import path from 'path';
import { query, execute } from '../../db/pg-repo.js';
import { getProject } from '../pm/project-manager.js';
import { removeSessionStaging } from './resumable-upload-storage.js';
import type { UploadSessionRow } from './resumable-upload-types.js';

/** Mark expired sessions and remove their project-local staging folders. */
export async function cleanupExpiredResumableUploads(): Promise<{ expired: number; cleaned: number }> {
  const expired = await query<UploadSessionRow>(`
    SELECT * FROM upload_sessions
    WHERE status IN ('created', 'uploading', 'failed') AND expires_at < now()
  `);
  if (expired.length === 0) return { expired: 0, cleaned: 0 };

  await execute(`
    UPDATE upload_sessions
    SET status = 'expired', updated_at = now(), error = COALESCE(error, 'Upload session expired')
    WHERE status IN ('created', 'uploading', 'failed') AND expires_at < now()
  `);

  let cleaned = 0;
  for (const session of expired) {
    try {
      const project = await getProject(session.project_id);
      if (!project?.rootPath) continue;
      await removeSessionStaging(path.resolve(project.rootPath), session.id);
      cleaned++;
    } catch (err) {
      console.warn('[resumable-upload] expired staging cleanup failed:', session.id, err);
    }
  }
  return { expired: expired.length, cleaned };
}

/** Fire-and-forget startup cleanup with a small delay so boot is not blocked. */
export function scheduleResumableUploadStartupCleanup(): void {
  setTimeout(() => {
    cleanupExpiredResumableUploads()
      .then((r) => {
        if (r.expired > 0) console.log(`[resumable-upload] expired sessions=${r.expired}, cleaned=${r.cleaned}`);
      })
      .catch((err) => console.warn('[resumable-upload] startup cleanup failed:', err));
  }, 5000).unref?.();
}
