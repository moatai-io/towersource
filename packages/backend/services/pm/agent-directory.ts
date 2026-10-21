import type { AgentDirectoryEntry, AgentDirectoryVisibility } from '@tower/shared';
import { query, queryOne, transaction } from '../../db/pg-repo.js';

export class AgentDirectoryError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Re-read the account: a cached JWT role is not directory or settings authority. */
async function directoryActor(userId: number) {
  const actor = await queryOne<{ role: string; disabled: number }>('SELECT role, disabled FROM users WHERE id = $1', [userId]);
  // Discovery is restricted to current invited staff. This endpoint never
  // acquires project membership or execution authority.
  if (!actor || actor.disabled !== 0 || !['admin', 'operator', 'member', 'viewer'].includes(actor.role)) {
    throw new AgentDirectoryError(403, 'Active company account required');
  }
  return actor;
}

/** Safe DTO: never return Project objects, instructions, paths or Session facts. */
export async function listAgentDirectory(userId: number): Promise<AgentDirectoryEntry[]> {
  await directoryActor(userId);
  const rows = await query<{
    id: string; name: string; short_role: string | null; contact_name: string | null;
    is_member: boolean;
  }>(`
    SELECT p.id, LEFT(COALESCE(NULLIF(TRIM(pap.display_name), ''), p.name), 120) AS name,
      LEFT(COALESCE(NULLIF(TRIM(pap.tagline), ''), NULLIF(TRIM(pap.role), ''), p.description), 240) AS short_role,
      COALESCE(owner.contact_name, NULLIF(creator.display_name, ''), creator.username) AS contact_name,
      EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $1) AS is_member
    FROM projects p
    LEFT JOIN project_agent_profiles pap ON pap.project_id = p.id
    LEFT JOIN users creator ON creator.id = p.user_id AND creator.disabled = 0
    LEFT JOIN LATERAL (
      SELECT COALESCE(NULLIF(u.display_name, ''), u.username) AS contact_name
      FROM project_members pm JOIN users u ON u.id = pm.user_id AND u.disabled = 0
      WHERE pm.project_id = p.id AND pm.role = 'owner'
      ORDER BY pm.added_at, pm.user_id LIMIT 1
    ) owner ON TRUE
    WHERE EXISTS (SELECT 1 FROM project_members invited WHERE invited.project_id = p.id AND invited.user_id = $1)
      AND p.system_key IS NULL
      AND COALESCE(p.archived, 0) = 0 AND COALESCE(p.lifecycle_status, 'active') = 'active'
      AND (pap.project_id IS NULL OR pap.status IN ('active', 'ready'))
    ORDER BY name, p.id
  `, [userId]);
  return rows.filter(row => row.is_member === true).map(row => ({
    projectId: row.id,
    name: row.name,
    shortRole: row.short_role,
    contactName: row.contact_name,
    access: 'available',
  }));
}

/** Visibility is an owner/company-management setting, never a membership edit. */
export async function agentDirectoryVisibility(userId: number, projectId: string, visibility?: AgentDirectoryVisibility) {
  return transaction(async client => {
    const actorResult = await client.query('SELECT role, disabled FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const actor = actorResult.rows[0];
    if (!actor || actor.disabled !== 0 || !['admin', 'operator', 'member'].includes(actor.role)) {
      throw new AgentDirectoryError(403, 'Active writable account required');
    }
    const result = await client.query(`SELECT p.directory_visibility,
      EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $2 AND pm.role = 'owner') AS is_owner
      FROM projects p WHERE p.id = $1 AND p.system_key IS NULL
      AND COALESCE(p.archived, 0) = 0 AND COALESCE(p.lifecycle_status, 'active') = 'active' FOR UPDATE OF p`, [projectId, userId]);
    const project = result.rows[0];
    if (!project) throw new AgentDirectoryError(404, 'Agent not found');
    if (!project.is_owner) {
      throw new AgentDirectoryError(403, 'Only an invited owner can manage directory visibility');
    }
    if (visibility !== undefined) {
      await client.query('UPDATE projects SET directory_visibility = $2 WHERE id = $1', [projectId, visibility]);
    }
    return { projectId, visibility: (visibility ?? project.directory_visibility ?? 'unlisted') as AgentDirectoryVisibility };
  });
}

/** Name-only history. Session ownership is evidence of prior use, never current access. */
export async function listPreviousAgentParticipation(userId: number): Promise<Array<{ id: string; name: string }>> {
  await directoryActor(userId);
  return query<{ id: string; name: string }>(`
    SELECT p.id, LEFT(COALESCE(NULLIF(TRIM(pap.display_name), ''), p.name), 120) AS name
    FROM projects p LEFT JOIN project_agent_profiles pap ON pap.project_id = p.id
    WHERE p.archived = 0 AND p.deleted_at IS NULL
      AND COALESCE(p.lifecycle_status, 'active') = 'active'
      AND EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = p.id AND s.user_id = $1)
      AND NOT EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $1)
    ORDER BY name, p.id
  `, [userId]);
}
