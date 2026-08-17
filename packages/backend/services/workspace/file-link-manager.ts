import { randomBytes, randomUUID } from 'crypto';
import { execute, queryOne } from '../../db/pg-repo.js';

/**
 * file-link-manager.ts — short authenticated workspace file links.
 *
 * Owns: mapping human-friendly `/f/:shortId` links to concrete workspace file
 * paths. Authorization remains enforced by the normal file APIs after resolve.
 * See services/workspace/_DECISIONS.md.
 */

export interface FileLink {
  id: string;
  short_id: string;
  file_path: string;
  owner_id: number;
  created_at: string;
  last_accessed_at?: string | null;
}

function newShortId(): string {
  return randomBytes(9).toString('base64url').slice(0, 8);
}

/** Create or reuse a short link owned by the current user for a file path. */
export async function createFileLink(filePath: string, ownerId: number): Promise<FileLink> {
  const existing = await queryOne<FileLink>(
    'SELECT * FROM file_links WHERE file_path = $1 AND owner_id = $2 LIMIT 1',
    [filePath, ownerId],
  );
  if (existing) return existing;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const shortId = newShortId();
    try {
      await execute(`
        INSERT INTO file_links (id, short_id, file_path, owner_id)
        VALUES ($1, $2, $3, $4)
      `, [randomUUID(), shortId, filePath, ownerId]);
      return await queryOne<FileLink>('SELECT * FROM file_links WHERE short_id = $1', [shortId]) as FileLink;
    } catch (error: any) {
      if (!String(error?.message || '').includes('duplicate key')) throw error;
    }
  }

  throw new Error('Failed to allocate a unique file link id.');
}

/** Resolve a short id to its file path. Authorization is checked by the caller. */
export async function getFileLinkByShortId(shortId: string): Promise<FileLink | undefined> {
  const link = await queryOne<FileLink>('SELECT * FROM file_links WHERE short_id = $1', [shortId]);
  if (link) {
    await execute('UPDATE file_links SET last_accessed_at = NOW() WHERE short_id = $1', [shortId]).catch(() => ({ changes: 0 }));
  }
  return link;
}
