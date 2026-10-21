/** Internal direct inventory. Not a mount capability or a public discovery API. */
import { query } from '../../db/pg-repo.js';
import { requireAgentWorkspaceAccess } from './access.js';

export async function listAgentWorkspaceInventory(input: { userId: number; agentProjectId: string }) {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0 || typeof input.agentProjectId !== 'string'
    || !input.agentProjectId.trim() || input.agentProjectId.length > 200) throw new Error('AGENT_WORKSPACE_CONTEXT_REQUIRED');
  // Rooted only in this Agent. No recursive CTE or target-Agent grant expansion.
  const rows = await query<{ id: string }>(`
    SELECT w.id FROM agent_workspaces w
      LEFT JOIN agent_workspace_grants g ON g.workspace_id=w.id AND g.agent_project_id=$1
     WHERE w.state='active' AND
       ((w.kind='project' AND w.owner_project_id=$1)
        OR (g.revoked_at IS NULL AND g.mode IN ('read','read-write')))
     ORDER BY w.id LIMIT 257`, [input.agentProjectId]);
  if (rows.length > 256) throw new Error('WORKSPACE_INVENTORY_LIMIT');
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('WORKSPACE_INVENTORY_INVALID');
  const result = [];
  for (const row of rows) {
    // Propagate revocation/inactive failures; do not return a partial stale list.
    const access = await requireAgentWorkspaceAccess({ ...input, workspaceId: row.id, operation: 'read' });
    let readOnly = true;
    try {
      const writable = await requireAgentWorkspaceAccess({ ...input, workspaceId: row.id, operation: 'write' });
      if (writable.grantVersion !== access.grantVersion || writable.ownerProjectId !== access.ownerProjectId
        || writable.mode !== access.mode) throw new Error('WORKSPACE_INVENTORY_CHANGED');
      readOnly = false;
    } catch (error) {
      if (!(error instanceof Error) || !['AGENT_WRITE_DENIED', 'WORKSPACE_READ_ONLY'].includes(error.message)) throw error;
    }
    result.push({ workspaceId: row.id, workspaceKind: access.workspaceKind, ownerProjectId: access.ownerProjectId,
      readOnly, grantVersion: access.grantVersion });
  }
  return result;
}
