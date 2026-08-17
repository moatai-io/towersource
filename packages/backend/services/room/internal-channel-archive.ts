/**
 * Read-only archive projection for retired internal chat_rooms.
 *
 * This deliberately returns an allowlisted projection. Never add storage paths,
 * raw/hash credentials, or room_ai_context payloads to this contract.
 */
import { query, queryOne } from '../../db/pg-repo.js';
import { getMessages, getMembers, getRoom, type RoomMessage } from './room-manager.js';
import { listChannelResourceLinks } from './channel-resource-links.js';
import { listChannelSharedFiles } from './channel-shared-files.js';
import { listChannelAgents } from './channel-agent-memberships.js';

const ARCHIVE_PAGE_MAX = 200;

function safeMessageMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of ['source', 'model', 'status', 'legacyMode', 'token_label']) {
    const value = metadata?.[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') safe[key] = value;
  }
  return safe;
}

function projectMessage(message: RoomMessage) {
  return {
    id: message.id,
    shortId: message.shortId ?? null,
    seq: message.seq,
    senderId: message.senderId,
    senderName: message.senderName,
    msgType: message.msgType,
    content: message.content,
    metadata: safeMessageMetadata(message.metadata),
    taskId: message.taskId,
    replyTo: message.replyTo,
    editedAt: message.editedAt,
    createdAt: message.createdAt,
  };
}

export async function getInternalChannelArchiveManifest(roomId: string) {
  const room = await getRoom(roomId);
  if (!room) return null;

  const [members, resources, files, agents, counts, webhookRows] = await Promise.all([
    getMembers(roomId),
    listChannelResourceLinks(roomId),
    listChannelSharedFiles(roomId),
    listChannelAgents(roomId),
    queryOne<any>(
      `SELECT
         (SELECT COUNT(*)::int FROM room_messages WHERE room_id = $1 AND deleted_at IS NULL) AS message_count,
         (SELECT MIN(created_at) FROM room_messages WHERE room_id = $1 AND deleted_at IS NULL) AS first_message_at,
         (SELECT MAX(created_at) FROM room_messages WHERE room_id = $1 AND deleted_at IS NULL) AS last_message_at,
         (SELECT COUNT(*)::int FROM room_ai_context WHERE room_id = $1) AS excluded_ai_context_count`,
      [roomId],
    ),
    query<any>(
      `SELECT rwt.label, rwt.created_at, rwt.last_used_at, rwt.revoked_at,
              creator.username AS created_by_name
         FROM room_webhook_tokens rwt
         LEFT JOIN users creator ON creator.id = rwt.created_by
        WHERE rwt.room_id = $1
        ORDER BY rwt.created_at ASC`,
      [roomId],
    ),
  ]);

  return {
    schemaVersion: 1,
    readOnly: true,
    generatedAt: new Date().toISOString(),
    room: {
      id: room.id,
      shortCode: room.shortCode ?? null,
      name: room.name,
      description: room.description,
      roomType: room.roomType,
      kind: room.kind,
      archived: room.archived,
      createdBy: room.createdBy,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      legacyOriginProjectId: room.legacyOriginProjectId,
      legacyOriginProjectName: room.legacyOriginProjectName,
    },
    counts: {
      messages: Number(counts?.message_count) || 0,
      members: members.length,
      resources: resources.length,
      sharedFiles: files.length,
      agents: agents.length,
      webhooks: webhookRows.length,
      excludedAiContextRows: Number(counts?.excluded_ai_context_count) || 0,
    },
    range: {
      firstMessageAt: counts?.first_message_at ?? null,
      lastMessageAt: counts?.last_message_at ?? null,
    },
    members: members.map((member) => ({
      userId: member.userId,
      username: member.username,
      role: member.role,
      joinedAt: member.joinedAt,
      lastReadAt: member.lastReadAt,
      invitedBy: member.invitedBy,
      membershipSource: member.membershipSource,
    })),
    resources: resources.map((resource) => ({
      resourceType: resource.resourceType,
      resourceId: resource.resourceId,
      capability: resource.capability,
      createdAt: resource.createdAt,
    })),
    sharedFiles: files.map((file) => ({
      id: file.id,
      originalName: file.originalName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      uploadedBy: file.uploadedBy,
      uploadedByName: file.uploadedByName,
      createdAt: file.createdAt,
    })),
    agents: agents.map((agent) => ({
      projectId: agent.projectId,
      displayName: agent.displayName,
      face: agent.face,
      tagline: agent.tagline,
      createdAt: agent.createdAt,
    })),
    webhooks: webhookRows.map((row) => ({
      label: row.label,
      createdByName: row.created_by_name ?? null,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? null,
      status: row.revoked_at ? 'revoked' : 'retired',
    })),
    exclusions: ['room_ai_context payloads', 'shared-file storage paths', 'webhook raw tokens', 'webhook token hashes', 'webhook token ids'],
  };
}

export async function getInternalChannelArchiveMessages(
  roomId: string,
  options: { limit?: number; before?: string; after?: string } = {},
) {
  const limit = Math.max(1, Math.min(options.limit ?? ARCHIVE_PAGE_MAX, ARCHIVE_PAGE_MAX));
  const messages = await getMessages(roomId, { limit, before: options.before, after: options.after });
  const projected = messages.map(projectMessage);
  return {
    messages: projected,
    page: {
      limit,
      count: projected.length,
      firstSeq: projected[0]?.seq ?? null,
      lastSeq: projected.at(-1)?.seq ?? null,
      hasMore: projected.length === limit,
    },
  };
}
