import { createHash, randomUUID } from 'node:crypto';
import { transaction } from '../../db/pg-repo.js';
import {
  previewTeamManagementInTransaction, applyTeamManagementInTransaction, validateTeamManagementInput,
  type TeamManagementCommand, type TeamManagementPreview,
} from './team-management.js';

// Sort object keys for a stable hash across JSONB serialization; array order is intentional.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function previewHash(preview: TeamManagementPreview): string {
  return createHash('sha256').update(canonical(preview)).digest('hex');
}

/** Server-issued 10-minute approval receipt. Show this preview/hash before approving.
 * Input is an exact command, never a client-created preview. This does not execute it.
 */
export async function createTeamManagementIntent(input: { actorUserId: number; command: TeamManagementCommand }): Promise<{
  intentId: string; proposalHash: string; expiresAt: string; preview: TeamManagementPreview;
}> {
  validateTeamManagementInput(input.actorUserId, input.command);
  return transaction(async client => {
    const preview = await previewTeamManagementInTransaction(client, input);
    const intentId = randomUUID();
    const proposalHash = previewHash(preview);
    const row = (await client.query(`INSERT INTO team_management_intents
      (id,actor_user_id,proposal_hash,preview,expires_at) VALUES ($1,$2,$3,$4::jsonb,clock_timestamp()+interval '10 minutes')
      RETURNING expires_at`, [intentId, input.actorUserId, proposalHash, JSON.stringify(preview)])).rows[0];
    return { intentId, proposalHash, expiresAt: new Date(row.expires_at).toISOString(), preview };
  });
}

/** Only authenticated actor + server-issued identifiers cross the apply boundary.
 * Intent lock, current admin/target checks, CAS mutation and consumed receipt commit
 * together. Any denial/stale/expired/apply error rolls back both mutation and consumption.
 * No route/UI activation here; confirmed must come from an explicit user approval flow.
 */
export async function applyTeamManagementIntent(input: { actorUserId: number; intentId: string; proposalHash: string; confirmed: boolean }): Promise<{
  changed: boolean; teamVersion: number;
}> {
  if (input.confirmed !== true) throw new Error('TEAM_MANAGEMENT_CONFIRMATION_REQUIRED');
  if (!Number.isSafeInteger(input.actorUserId) || input.actorUserId <= 0
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.intentId)
    || !/^[0-9a-f]{64}$/.test(input.proposalHash)) throw new Error('TEAM_MANAGEMENT_INPUT_INVALID');
  return transaction(async client => {
    const row = (await client.query(`SELECT actor_user_id,proposal_hash,preview,consumed_at,
      expires_at<=clock_timestamp() AS expired FROM team_management_intents WHERE id=$1 FOR UPDATE`, [input.intentId])).rows[0];
    if (!row) throw new Error('TEAM_MANAGEMENT_INTENT_NOT_FOUND');
    if (row.actor_user_id !== input.actorUserId || row.proposal_hash !== input.proposalHash
      || row.preview.actorUserId !== input.actorUserId || previewHash(row.preview) !== row.proposal_hash) {
      throw new Error('TEAM_MANAGEMENT_INTENT_BINDING');
    }
    if (row.consumed_at !== null) throw new Error('TEAM_MANAGEMENT_INTENT_CONSUMED');
    if (row.expired) throw new Error('TEAM_MANAGEMENT_INTENT_EXPIRED');
    const result = await applyTeamManagementInTransaction(client, {
      actorUserId: input.actorUserId, preview: row.preview, confirmed: true,
    });
    // Locks may have waited; use wall-clock expiry again, not transaction-start now().
    const consumed = await client.query(`UPDATE team_management_intents
      SET consumed_at=clock_timestamp(),result=$2::jsonb
      WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING id`, [input.intentId, JSON.stringify(result)]);
    if (consumed.rowCount !== 1) throw new Error('TEAM_MANAGEMENT_INTENT_EXPIRED');
    return result;
  });
}
