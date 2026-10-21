import { randomUUID } from 'node:crypto';
import { query, transaction } from '../../db/pg-repo.js';

export type ParticipationScope = 'project' | 'channel';
export class ParticipationError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function hasAdministratorParticipation(_scope: ParticipationScope, _targetId: string, _userId: number): Promise<boolean> {
  // Legacy operational participation is never a content or audience grant.
  return false;
}

export async function listAdministratorParticipants(scope: ParticipationScope, targetId: string) {
  const column = scope === 'project' ? 'project_id' : 'room_id';
  return query(`SELECT ap.id, ap.user_id AS "userId", u.username, ap.joined_at AS "joinedAt"
    FROM administrator_participations ap JOIN users u ON u.id = ap.user_id
    WHERE ap.${column} = $1 AND ap.left_at IS NULL AND u.role = 'operator' AND u.disabled = 0
    ORDER BY ap.joined_at`, [targetId]);
}

/** Self-entry is disabled. Historical leaves and immutable audit commit atomically. */
export async function changeAdministratorParticipation(input: { scope: ParticipationScope; targetId: string; userId: number; join: boolean }) {
  const column = input.scope === 'project' ? 'project_id' : 'room_id';
  const table = input.scope === 'project' ? 'projects' : 'chat_rooms';
  if (input.join) throw new ParticipationError(403, 'Self-entry is disabled; an explicit invitation is required');
  return transaction(async client => {
    // Serializes joins with current-role changes and concurrent entries by this actor,
    // including first entry where no participation row exists yet. Never trust a long-lived JWT.
    const actor = await client.query('SELECT role, disabled FROM users WHERE id = $1 FOR UPDATE', [input.userId]);
    if (!actor.rows[0] || actor.rows[0].disabled !== 0) {
      throw new ParticipationError(403, 'Active company administrator required');
    }
    const target = await client.query(`SELECT id FROM ${table} WHERE id = $1 FOR KEY SHARE`, [input.targetId]);
    if (!target.rows[0]) throw new ParticipationError(404, 'Participation target not found');
    const existing = await client.query(`SELECT id, left_at FROM administrator_participations WHERE ${column} = $1 AND user_id = $2 FOR UPDATE`, [input.targetId, input.userId]);
    const prior = existing.rows[0];
    if (!prior || prior.left_at !== null) {
      return { changed: false, joined: input.join, participationId: prior?.id ?? null };
    }
    const id = prior.id;
    await client.query('UPDATE administrator_participations SET left_at = now() WHERE id = $1', [id]);
    const eventId = randomUUID();
    await client.query(`INSERT INTO administrator_participation_events(id, participation_id, actor_user_id, ${column}, event_type) VALUES($1,$2,$3,$4,$5)`, [eventId, id, input.userId, input.targetId, 'left']);
    return { changed: true, joined: input.join, participationId: id, eventId };
  });
}
