import { assertOrdinaryAgentCreationAuthority } from '../authority/agent-authority-policy-update.js';
/**
 * Owns: server-issued approval intents for complete Primary Agent staffing packages.
 * Public API: createPrimaryAgentCreationIntent, consumePrimaryAgentCreationIntent, primaryAgentStaffingHash.
 */
import { createHash } from 'node:crypto';
import { queryOne } from '../../db/pg-repo.js';
import type { PrimaryAgentCapabilityRequirements, PrimaryAgentHarnessBinding } from './primary-agent-staffing.js';

export interface PrimaryAgentRoiContract {
  primaryMetric: string;
  baseline?: string;
  target: string;
  confidence?: 'low' | 'medium' | 'high';
  reviewAfterDays?: number;
}

export interface PrimaryAgentStaffingPayload {
  name: string;
  description?: string;
  face: string;
  tagline: string;
  role: string;
  promise: string;
  instruction: string;
  firstMission: string;
  authorityPolicy?: Record<string, unknown>;
  toolPolicy?: Record<string, unknown>;
  roiContract?: PrimaryAgentRoiContract;
  capabilityRequirements: PrimaryAgentCapabilityRequirements;
  harnessBinding: PrimaryAgentHarnessBinding;
  /** Bootstrap creation keeps the profile provisional while the legacy staffed path remains ready. */
  creationMode?: 'bootstrap' | 'staffed';
  sourceExpertiseIntent?: string;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Content identity of the complete staffing package the server previewed. */
export function primaryAgentStaffingHash(payload: PrimaryAgentStaffingPayload): string {
  return createHash('sha256').update(stable(payload)).digest('hex');
}

/** Verify the actor can use the source Project as an approval context and issue a short-lived intent. */
export async function createPrimaryAgentCreationIntent(input: {
  actorUserId: number;
  actorRole: string;
  sourceProjectId: string;
  payload: PrimaryAgentStaffingPayload;
}) {
  assertOrdinaryAgentCreationAuthority(input.payload.authorityPolicy);
  if (input.actorRole === 'guest' || input.actorRole === 'viewer') throw new Error(`Role '${input.actorRole}' cannot create Primary Agents`);
  const source = await queryOne<{ system_key: string | null }>(
    `SELECT p.system_key
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=$2
      WHERE p.id=$1 AND (p.archived IS NULL OR p.archived=0)
        AND ($3::boolean OR pm.user_id IS NOT NULL)`,
    [input.sourceProjectId, input.actorUserId, input.actorRole === 'admin' || input.actorRole === 'operator'],
  );
  if (!source) throw new Error('Primary Agent creation requires an accessible source Project');
  const staffingHash = primaryAgentStaffingHash(input.payload);
  const row = await queryOne<{ id: string; expires_at: string }>(
    `INSERT INTO primary_agent_creation_intents(actor_user_id,source_project_id,staffing_hash,staffing_payload,expires_at)
     VALUES($1,$2,$3,$4::jsonb,NOW()+INTERVAL '30 minutes') RETURNING id,expires_at`,
    [input.actorUserId, input.sourceProjectId, staffingHash, JSON.stringify(input.payload)],
  );
  if (!row) throw new Error('Failed to issue Primary Agent creation intent');
  return { approvalIntentId: row.id, staffingHash, expiresAt: row.expires_at };
}

/**
 * Atomically consume an approval intent for one creation command.
 * Re-entry is allowed only for the same command, including after the original expiry.
 */
export async function consumePrimaryAgentCreationIntent(input: {
  approvalIntentId: string;
  commandId: string;
  actorUserId: number;
  sourceProjectId: string;
  approvedCardHash: string;
  payload: PrimaryAgentStaffingPayload;
  db?: { queryOne<T = any>(sql: string, params?: any[]): Promise<T | undefined> };
}): Promise<void> {
  assertOrdinaryAgentCreationAuthority(input.payload.authorityPolicy);
  const expectedHash = primaryAgentStaffingHash(input.payload);
  if (input.approvedCardHash !== expectedHash) throw new Error('Approved Staffing Package hash does not match the creation payload');
  const consumed = await (input.db?.queryOne || queryOne)<{ id: string }>(
    `UPDATE primary_agent_creation_intents
        SET consumed_at=COALESCE(consumed_at,NOW()),
            consumed_by_command_id=COALESCE(consumed_by_command_id,$5)
      WHERE id=$1 AND actor_user_id=$2 AND source_project_id=$3 AND staffing_hash=$4
        AND (expires_at>NOW() OR consumed_by_command_id=$5)
        AND (consumed_by_command_id IS NULL OR consumed_by_command_id=$5)
      RETURNING id`,
    [input.approvalIntentId, input.actorUserId, input.sourceProjectId, expectedHash, input.commandId],
  );
  if (!consumed) throw new Error('Valid unused server-approved Staffing Package intent required');
}
