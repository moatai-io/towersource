/**
 * session-project-files.ts — project-scoped recent files for sidebar fallback.
 *
 * When the active session has no working-set files yet (session_file_edits = 0
 * after the user-facing filter), the Sidebar sessions-tab panel falls back to
 * showing files recently edited by *other sessions in the same project*.
 *
 * Owns: GET /api/sessions/:id/project-recent-files data layer.
 * Public API: getProjectRecentFiles(sessionId, limit?).
 *
 * Data source:
 *   session_file_edits JOIN sessions ON sessions.id = session_file_edits.session_id
 *   WHERE sessions.project_id = <this session's project_id>
 *     AND sessions.id != <this session's id>
 *   GROUP BY file_path, ORDER BY MAX(created_at) DESC
 *
 * If the session has no project_id:
 *   returns { files: [], projectMissing: true, queryMs }
 *
 * User-facing filter: shared with session-touched-files.ts. Code files are
 * filtered out — only doc/data/web/image/office-style files surface.
 *
 * Decision: workspace/decisions/2026-05-22-sidebar-session-files-panel.md
 * Related:  workspace/decisions/2026-05-20-session-scoped-file-tabs.md
 */
import { query, queryOne } from '../../db/pg-repo.js';
import type { ProjectRecentFilesResponse, ProjectRecentFile } from '@tower/shared';
import { isUserFacingSessionFile } from './session-file-filter.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * Return files recently edited by other sessions in the same project.
 *
 * Used as the fallback data source when the active session's own working set
 * is empty (no user-facing files in session_file_edits for this session).
 *
 * @param sessionId  — The *active* session's UUID (excluded from results).
 * @param limit      — max rows returned (1-50, default 20).
 */
export async function getProjectRecentFiles(
  sessionId: string,
  limit = DEFAULT_LIMIT,
): Promise<ProjectRecentFilesResponse> {
  const started = Date.now();
  const n = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit) || DEFAULT_LIMIT));

  // 1. Resolve the session's project_id.
  const sessionRow = await queryOne<{ project_id: string | null }>(
    `SELECT project_id FROM sessions WHERE id = $1`,
    [sessionId],
  );

  if (!sessionRow || !sessionRow.project_id) {
    return { files: [], projectMissing: true, queryMs: Date.now() - started };
  }

  const projectId = sessionRow.project_id;

  // 2. Over-fetch so the user-facing filter still hits `n` after dropping
  //    code-only sessions. Factor 4 is generous — even heavy coder projects
  //    will have some doc files among the first 80 rows.
  const FILTER_BUFFER = 4;
  const fetchN = Math.min(MAX_LIMIT * FILTER_BUFFER, n * FILTER_BUFFER);

  // 3. Group by file_path, pick the most recent touch across all sessions in
  //    the project (excluding the caller's session). Also surface the session
  //    name for the hover tooltip ("출처 세션").
  const rows = await query<{
    file_path: string;
    tool_name: string;
    last_touched_at: string | Date;
    session_id: string;
    session_name: string;
  }>(
    `SELECT
       sfe.file_path,
       (array_agg(sfe.tool_name ORDER BY sfe.created_at DESC))[1] AS tool_name,
       MAX(sfe.created_at)                                          AS last_touched_at,
       (array_agg(sfe.session_id ORDER BY sfe.created_at DESC))[1] AS session_id,
       (array_agg(s.name        ORDER BY sfe.created_at DESC))[1]  AS session_name
     FROM session_file_edits sfe
     JOIN sessions s ON s.id = sfe.session_id
     WHERE s.project_id = $1
       AND sfe.session_id != $2
     GROUP BY sfe.file_path
     ORDER BY MAX(sfe.created_at) DESC
     LIMIT $3`,
    [projectId, sessionId, fetchN],
  );

  const files: ProjectRecentFile[] = rows
    .filter((r) => isUserFacingSessionFile(r.file_path))
    .slice(0, n)
    .map((r) => ({
      path: r.file_path,
      toolName: r.tool_name ?? 'unknown',
      lastTouchedAt:
        r.last_touched_at instanceof Date
          ? r.last_touched_at.toISOString()
          : String(r.last_touched_at),
      sessionId: r.session_id,
      sessionName: r.session_name ?? '(알 수 없는 세션)',
    }));

  return { files, projectMissing: false, queryMs: Date.now() - started };
}
