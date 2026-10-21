import { queryOne } from '../../db/pg-repo.js';
import { isMcpServerExclusionList, type SessionMcpSelection } from '../../../shared/session-mcp-selection.js';

interface SelectionRow {
  id: string;
  project_id: string | null;
  engine: string | null;
  mcp_excluded_server_names: unknown;
}

function selectionFromRow(row: SelectionRow): SessionMcpSelection {
  // NULL is a legacy/default selection; malformed stored policy must never widen access.
  const excluded = row.mcp_excluded_server_names ?? [];
  if (!isMcpServerExclusionList(excluded)) throw new Error('Invalid stored MCP selection');
  return { sessionId: row.id, projectId: row.project_id, supported: row.engine === 'pi', excludedServerNames: [...new Set(excluded)] };
}

export async function getSessionMcpSelection(sessionId: string): Promise<SessionMcpSelection | undefined> {
  const row = await queryOne<SelectionRow>(
    'SELECT id, project_id, engine, mcp_excluded_server_names FROM sessions WHERE id = $1', [sessionId],
  );
  return row ? selectionFromRow(row) : undefined;
}

export async function setSessionMcpSelection(
  sessionId: string,
  projectId: string | null,
  excludedServerNames: string[],
): Promise<SessionMcpSelection | undefined> {
  if (!isMcpServerExclusionList(excludedServerNames)) throw new Error('Invalid MCP exclusions');
  const row = await queryOne<SelectionRow>(
    `UPDATE sessions SET mcp_excluded_server_names = $3::jsonb
     WHERE id = $1 AND project_id IS NOT DISTINCT FROM $2 AND engine = 'pi'
     RETURNING id, project_id, engine, mcp_excluded_server_names`,
    [sessionId, projectId, JSON.stringify([...new Set(excludedServerNames)])],
  );
  return row ? selectionFromRow(row) : undefined;
}

/** Read on every gateway search/call: a previously discovered tool is not permission. */
export function createSessionMcpServerChecker(context: {
  sessionId: string;
  projectId?: string;
  /** Optional caller opt-outs may tighten, but never replace, persisted policy. */
  mcpExcludedServerNames?: readonly string[];
}): (serverName: string) => Promise<boolean> {
  return async serverName => {
    if (!context.projectId || context.mcpExcludedServerNames?.includes(serverName)) return false;
    const selection = await getSessionMcpSelection(context.sessionId);
    return !!selection && selection.supported && selection.projectId === context.projectId
      && !selection.excludedServerNames.includes(serverName);
  };
}
