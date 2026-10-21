import { randomUUID } from 'node:crypto';
import { transaction } from '../../db/pg-repo.js';

/** Explicit admin-panel entry: ordinary membership, not a content ACL bypass. */
export async function joinAgentAsAdministrator(projectId: string, userId: number) {
  return transaction(async client => {
    const actor = (await client.query('SELECT role, disabled FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
    if (!actor || actor.disabled || !['admin', 'operator'].includes(actor.role)) throw Object.assign(new Error('Administrator or operator required'), { status: 403 });
    const project = (await client.query("SELECT id, name, user_id FROM projects WHERE id=$1 AND archived=0 AND COALESCE(lifecycle_status,'active')='active' FOR UPDATE", [projectId])).rows[0];
    if (!project) throw Object.assign(new Error('Active Agent not found'), { status: 404 });
    const existing = (await client.query('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2', [projectId, userId])).rows[0];
    if (existing) return { joined: true, changed: false, role: existing.role, ownerId: project.user_id, name: project.name };
    await client.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'member')", [projectId, userId]);
    const participationId = randomUUID();
    await client.query(`INSERT INTO administrator_participations(id,user_id,project_id,room_id,joined_at,left_at) VALUES($1,$2,$3,NULL,now(),NULL)
      ON CONFLICT (project_id,user_id) WHERE project_id IS NOT NULL DO UPDATE SET joined_at=now(),left_at=NULL`, [participationId, userId, projectId]);
    const recorded = (await client.query('SELECT id FROM administrator_participations WHERE project_id=$1 AND user_id=$2', [projectId, userId])).rows[0];
    await client.query("INSERT INTO administrator_participation_events(id,participation_id,actor_user_id,project_id,event_type) VALUES($1,$2,$3,$4,'joined')", [randomUUID(), recorded.id, userId, projectId]);
    return { joined: true, changed: true, role: 'member', ownerId: project.user_id, name: project.name };
  });
}
