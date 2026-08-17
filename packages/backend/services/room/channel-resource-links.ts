/**
 * Owns: explicit channel resource sharing grants. Public API: list/add/remove project links.
 * A link grants channel participants and invited Agents the declared capability;
 */
import { getPgPool } from '../../db/pg.js';

export type ChannelResourceCapability = 'discover' | 'read' | 'write';

export interface ChannelResourceLink {
  id: string;
  channelId: string;
  resourceType: 'project';
  resourceId: string;
  capability: ChannelResourceCapability;
  addedBy: number | null;
  createdAt: string;
}

const VALID_CAPABILITIES = new Set<ChannelResourceCapability>(['discover', 'read', 'write']);

function rowToChannelResourceLink(row: any): ChannelResourceLink {
  return {
    id: row.id,
    channelId: row.channel_id,
    resourceType: 'project',
    resourceId: row.resource_id,
    capability: row.capability,
    addedBy: row.added_by ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/** List active resources linked to a channel. */
export async function listChannelResourceLinks(channelId: string): Promise<ChannelResourceLink[]> {
  const { rows } = await getPgPool().query(
    `SELECT * FROM channel_resource_links
      WHERE channel_id = $1 AND revoked_at IS NULL
      ORDER BY created_at ASC`,
    [channelId],
  );
  return rows.map(rowToChannelResourceLink);
}

/** Share a project with this channel at the declared discover/read/write capability. */
export async function addChannelProjectLink(input: {
  channelId: string;
  projectId: string;
  capability?: ChannelResourceCapability;
  addedBy: number;
}): Promise<ChannelResourceLink> {
  const capability = input.capability ?? 'read';
  if (!VALID_CAPABILITIES.has(capability)) {
    throw new Error(`Invalid channel resource capability: ${capability}`);
  }

  const { rows } = await getPgPool().query(
    `INSERT INTO channel_resource_links (
       channel_id, resource_type, resource_id, capability, added_by, revoked_at
     ) VALUES ($1, 'project', $2, $3, $4, NULL)
     ON CONFLICT (channel_id, resource_type, resource_id)
     DO UPDATE SET capability = EXCLUDED.capability, added_by = EXCLUDED.added_by, revoked_at = NULL
     RETURNING *`,
    [input.channelId, input.projectId, capability, input.addedBy],
  );
  return rowToChannelResourceLink(rows[0]);
}

/** Revoke future channel access to a project. Project membership remains unchanged. */
export async function removeChannelProjectLink(channelId: string, projectId: string): Promise<boolean> {
  const result = await getPgPool().query(
    `UPDATE channel_resource_links
        SET revoked_at = NOW()
      WHERE channel_id = $1
        AND resource_type = 'project'
        AND resource_id = $2
        AND revoked_at IS NULL`,
    [channelId, projectId],
  );
  return (result.rowCount ?? 0) > 0;
}
