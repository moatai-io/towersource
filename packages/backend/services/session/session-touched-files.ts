/**
 * session-touched-files.ts — per-session working-set file list.
 *
 * Returns "files this session has edited, most recent first" for the
 * sidebar "이 세션의 파일" panel. Independent of session-backlinks but reads
 * the same table.
 *
 * Owns: GET /api/sessions/:id/touched-files data layer.
 * Public API: getTouchedFiles(sessionId, viewer, limit?).
 *
 * Data source:
 *   - session_file_edits (PostgreSQL) — UNIQUE (session_id, file_path).
 *     file-edit-log.ts refreshes created_at on every touch (ON CONFLICT
 *     DO UPDATE SET created_at = NOW()), so ORDER BY created_at DESC gives
 *     the working set in recency order.
 *
 * v1 scope (2026-05-20):
 *   - Edit / Write / NotebookEdit only (recorded by file-edit-log hook).
 *     Pure Read events are not tracked — the working set is "files I'm
 *     editing", not "files I glanced at". Revisit after dogfooding.
 *   - Caller's access to the session is checked at the API layer
 *     (canAccessSession). This module assumes the call is authorized.
 *
 * v2 scope (2026-05-22 — user-facing filter):
 *   - Only document-ish files surface in the sidebar panel. Code files
 *     (ts/tsx/js/py/sql/sh/etc.) and build-config files (package.json,
 *     tsconfig.json, .env*, lockfiles) are filtered out at the service
 *     layer — they're noise for non-coder users and even for coders they
 *     rarely match the *working-set* mental model.
 *   - session_file_edits still records everything (backlinks need code
 *     edits to score relatedness). The filter is presentational only.
 *
 * See: workspace/decisions/2026-05-20-session-scoped-file-tabs.md
 */
import { query } from '../../db/pg-repo.js';
import type { TouchedFile, TouchedFilesResponse } from '@tower/shared';
import { isUserFacingSessionFile } from './session-file-filter.js';
import { filterAccessibleSessionFiles, type SessionFileViewer } from './session-file-access.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50; // Allow higher limits for debugging; UI caps at 10.

/**
 * List files the session has edited, most recent first.
 *
 * @param sessionId — Tower sessions.id (UUID).
 * @param limit     — max rows (1-50, default 10).
 */
export async function getTouchedFiles(
  sessionId: string,
  viewer: SessionFileViewer,
  limit = DEFAULT_LIMIT,
): Promise<TouchedFilesResponse> {
  const started = Date.now();
  const n = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit) || DEFAULT_LIMIT));

  // Over-fetch so the user-facing filter can drop noise and still hit `n`.
  // Coder sessions often touch many .ts/.tsx files; without the buffer a
  // 10-row pull could land entirely on code and surface 0 chips.
  const FILTER_BUFFER = 5;
  const fetchN = Math.min(MAX_LIMIT * FILTER_BUFFER, n * FILTER_BUFFER);

  const rows = await query<{
    file_path: string;
    tool_name: string;
    created_at: string | Date;
  }>(
    `SELECT file_path, tool_name, created_at
       FROM session_file_edits
      WHERE session_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [sessionId, fetchN],
  );

  const files: TouchedFile[] = (await filterAccessibleSessionFiles(
    rows.filter((r) => isUserFacingSessionFile(r.file_path)), viewer,
  ))
    .slice(0, n)
    .map((r) => ({
      path: r.file_path,
      toolName: r.tool_name,
      lastTouchedAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));

  return {
    files,
    queryMs: Date.now() - started,
  };
}
