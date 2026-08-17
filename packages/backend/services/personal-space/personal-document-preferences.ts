import { execute, query, queryOne } from '../../db/pg-repo.js';
import { normalizePersonalPath, PersonalSpaceError, toPersonalUri } from './personal-space-store.js';

interface PreferenceRow {
  relative_path: string;
  pinned_at: string | null;
  last_opened_at: string | null;
}

export interface PersonalDocumentPreferences {
  pinnedUris: string[];
  recentUris: string[];
}

function validateUserId(userId: number): void {
  if (!Number.isInteger(userId) || userId <= 0) throw new PersonalSpaceError('INVALID_PATH', 'Invalid user');
}

async function resolveActiveFileId(userId: number, uri: string): Promise<string> {
  validateUserId(userId);
  const relativePath = normalizePersonalPath(uri);
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM personal_files WHERE owner_user_id = $1 AND relative_path = $2 AND deleted_at IS NULL`,
    [userId, relativePath],
  );
  if (!row) throw new PersonalSpaceError('NOT_FOUND', '개인 문서를 찾지 못했습니다');
  return row.id;
}

export async function listPersonalDocumentPreferences(userId: number): Promise<PersonalDocumentPreferences> {
  validateUserId(userId);
  const rows = await query<PreferenceRow>(
    `SELECT f.relative_path, p.pinned_at, p.last_opened_at
       FROM personal_document_preferences p
       JOIN personal_files f ON f.id = p.personal_file_id
      WHERE p.owner_user_id = $1 AND f.owner_user_id = $1 AND f.deleted_at IS NULL
        AND (p.pinned_at IS NOT NULL OR p.last_opened_at IS NOT NULL)`,
    [userId],
  );
  return {
    pinnedUris: rows.filter(row => row.pinned_at).sort((a, b) => String(b.pinned_at).localeCompare(String(a.pinned_at))).map(row => toPersonalUri(row.relative_path)),
    recentUris: rows.filter(row => row.last_opened_at).sort((a, b) => String(b.last_opened_at).localeCompare(String(a.last_opened_at))).slice(0, 20).map(row => toPersonalUri(row.relative_path)),
  };
}

export async function setPersonalDocumentPinned(userId: number, uri: string, pinned: boolean): Promise<PersonalDocumentPreferences> {
  const fileId = await resolveActiveFileId(userId, uri);
  await execute(
    `INSERT INTO personal_document_preferences(owner_user_id, personal_file_id, pinned_at, updated_at)
     VALUES ($1, $2, CASE WHEN $3 THEN NOW() ELSE NULL END, NOW())
     ON CONFLICT(owner_user_id, personal_file_id) DO UPDATE
       SET pinned_at = CASE WHEN $3 THEN NOW() ELSE NULL END, updated_at = NOW()`,
    [userId, fileId, pinned],
  );
  return listPersonalDocumentPreferences(userId);
}

export async function recordPersonalDocumentOpened(userId: number, uri: string): Promise<PersonalDocumentPreferences> {
  const fileId = await resolveActiveFileId(userId, uri);
  await execute(
    `INSERT INTO personal_document_preferences(owner_user_id, personal_file_id, last_opened_at, updated_at)
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT(owner_user_id, personal_file_id) DO UPDATE SET last_opened_at = NOW(), updated_at = NOW()`,
    [userId, fileId],
  );
  return listPersonalDocumentPreferences(userId);
}

/** Merge existing browser-only preferences without overwriting newer server state. */
export async function importPersonalDocumentPreferences(userId: number, pinnedUris: string[], recentUris: string[]): Promise<PersonalDocumentPreferences> {
  validateUserId(userId);
  const uniquePinned = [...new Set(pinnedUris)].slice(0, 100);
  const uniqueRecent = [...new Set(recentUris)].slice(0, 20);
  for (const uri of uniquePinned) {
    try {
      const fileId = await resolveActiveFileId(userId, uri);
      await execute(
        `INSERT INTO personal_document_preferences(owner_user_id, personal_file_id, pinned_at, updated_at)
         VALUES ($1, $2, NOW(), NOW()) ON CONFLICT(owner_user_id, personal_file_id) DO NOTHING`,
        [userId, fileId],
      );
    } catch (error) {
      if (!(error instanceof PersonalSpaceError) || error.code !== 'NOT_FOUND') throw error;
    }
  }
  for (let index = uniqueRecent.length - 1; index >= 0; index -= 1) {
    try {
      const fileId = await resolveActiveFileId(userId, uniqueRecent[index]);
      await execute(
        `INSERT INTO personal_document_preferences(owner_user_id, personal_file_id, last_opened_at, updated_at)
         VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 millisecond'), NOW())
         ON CONFLICT(owner_user_id, personal_file_id) DO NOTHING`,
        [userId, fileId, uniqueRecent.length - index],
      );
    } catch (error) {
      if (!(error instanceof PersonalSpaceError) || error.code !== 'NOT_FOUND') throw error;
    }
  }
  return listPersonalDocumentPreferences(userId);
}
