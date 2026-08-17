/**
 * Owns: project-scoped session↔file activity graph data.
 * Public API: getProjectActivityGraph(projectId, options).
 */
import path from 'node:path';
import { query } from '../../db/pg-repo.js';
import { isUserFacingSessionFile } from './session-file-filter.js';

export interface ActivityGraphSessionNode {
  id: string;
  kind: 'session';
  label: string;
  updatedAt: string;
  userName: string;
}

export interface ActivityGraphFileNode {
  id: string;
  kind: 'file';
  label: string;
  path: string;
  lastTouchedAt: string;
}

export interface ProjectActivityGraphResponse {
  rangeDays: number;
  nodes: Array<ActivityGraphSessionNode | ActivityGraphFileNode>;
  edges: Array<{ id: string; source: string; target: string; kind: 'edited'; lastTouchedAt: string }>;
  summary: { sessions: number; files: number; edges: number };
}

/** Returns recent visible project sessions and the user-facing files they edited. */
export async function getProjectActivityGraph(
  projectId: string,
  userId: number,
  options: { rangeDays?: number; sessionLimit?: number } = {},
): Promise<ProjectActivityGraphResponse> {
  const rangeDays = Math.max(1, Math.min(365, Math.floor(options.rangeDays ?? 90)));
  const sessionLimit = Math.max(1, Math.min(50, Math.floor(options.sessionLimit ?? 50)));
  const rows = await query<{
    session_id: string; session_name: string | null; session_updated_at: string | Date;
    user_name: string; file_path: string; touched_at: string | Date;
  }>(
    `WITH recent_sessions AS (
       SELECT s.id, s.name, s.updated_at, s.user_id
         FROM sessions s
        WHERE s.project_id = $1
          AND COALESCE(s.archived, 0) = 0
          AND (s.user_id = $2 OR s.visibility = 'project')
          AND s.updated_at >= NOW() - ($3::int * INTERVAL '1 day')
        ORDER BY s.updated_at DESC
        LIMIT $4
     )
     SELECT rs.id AS session_id, rs.name AS session_name, rs.updated_at AS session_updated_at,
            COALESCE(u.display_name, u.username, '알 수 없음') AS user_name,
            sfe.file_path, sfe.created_at AS touched_at
       FROM recent_sessions rs
       JOIN session_file_edits sfe ON sfe.session_id = rs.id
       LEFT JOIN users u ON u.id = rs.user_id
      ORDER BY rs.updated_at DESC, sfe.created_at DESC`,
    [projectId, userId, rangeDays, sessionLimit],
  );

  const sessions = new Map<string, ActivityGraphSessionNode>();
  const files = new Map<string, ActivityGraphFileNode>();
  const edges: ProjectActivityGraphResponse['edges'] = [];
  for (const row of rows) {
    if (!isUserFacingSessionFile(row.file_path)) continue;
    const sessionId = `session:${row.session_id}`;
    const fileId = `file:${row.file_path}`;
    const updatedAt = row.session_updated_at instanceof Date ? row.session_updated_at.toISOString() : String(row.session_updated_at);
    const touchedAt = row.touched_at instanceof Date ? row.touched_at.toISOString() : String(row.touched_at);
    sessions.set(sessionId, { id: sessionId, kind: 'session', label: row.session_name?.trim() || '제목 없는 세션', updatedAt, userName: row.user_name });
    const existing = files.get(fileId);
    if (!existing || existing.lastTouchedAt < touchedAt) {
      files.set(fileId, { id: fileId, kind: 'file', label: path.basename(row.file_path), path: row.file_path, lastTouchedAt: touchedAt });
    }
    edges.push({ id: `${sessionId}\u0000${fileId}`, source: sessionId, target: fileId, kind: 'edited', lastTouchedAt: touchedAt });
  }
  return {
    rangeDays,
    nodes: [...sessions.values(), ...files.values()],
    edges,
    summary: { sessions: sessions.size, files: files.size, edges: edges.length },
  };
}
