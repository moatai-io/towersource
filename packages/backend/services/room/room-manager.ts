/**
 * Room archive and Notification Hub persistence.
 *
 * Retired internal Channel data remains readable from PostgreSQL for archive,
 * access checks, and historical session continuity. Channel mutation helpers
 * have been removed; notification CRUD remains active.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPgPool } from '../../db/pg.js';
import { queryOne, query } from '../../db/pg-repo.js';
import { getAccessibleProjectIds } from '../pm/project-membership-manager.js';

// ── Types ────────────────────────────────────────────────────────────

export interface Room {
  id: string;
  /** Historical URL-friendly short code used by `/r/<shortCode>` archive links. */
  shortCode?: string;
  name: string;
  description: string | null;
  roomType: 'team' | 'project' | 'dashboard';
  /**
   * Whether this room is user-managed or system-managed.
   * 'user' (default) — normal user-created room.
   * 'tower_system'   — workspace-wide AI channel (Tower persona).
   * 'personal_ai'    — user-private AI/Noti channel by default.
   *                    See: workspace/decisions/2026-05-04-tower-channel-and-persona.md
   */
  kind: 'user' | 'tower_system' | 'personal_ai';
  /** Legacy primary project during the channel-resource compatibility window. */
  projectId: string | null;
  /** Active project/resource shares. */
  resourceLinks: Array<{
    resourceType: 'project';
    resourceId: string;
    capability: 'discover' | 'read' | 'write';
  }>;
  /** Historical Project origin before migration 117; informational only. */
  legacyOriginProjectId: string | null;
  legacyOriginProjectName: string | null;
  /** Number of other active user channels with the same normalized name. */
  duplicateNameCount: number;
  /** Current invited Primary Agents, used as the channel identity subtitle. */
  invitedAgentNames: string[];
  avatarUrl: string | null;
  archived: boolean;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface RoomMember {
  roomId: string;
  userId: number;
  username: string;
  role: 'owner' | 'admin' | 'member' | 'readonly';
  joinedAt: string;
  lastReadAt: string;
  invitedBy: number | null;
  membershipSource: 'creator' | 'manual_invite' | 'legacy_project_backfill' | 'system' | 'legacy_unknown';
}

export interface RoomMessage {
  id: string;
  /** Historical archive anchor token used by `/r/<roomShortCode>#m-<shortId>`. */
  shortId?: string | null;
  roomId: string;
  senderId: number | null;
  senderName: string | null;
  seq: number;
  msgType: 'human' | 'ai_summary' | 'ai_task_ref' | 'ai_error' | 'ai_reply' | 'system' | 'webhook';
  content: string;
  metadata: Record<string, unknown>;
  taskId: string | null;
  replyTo: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

// ── Username Cache (SQLite → memory) ─────────────────────────────────

const usernameCache = new Map<number, string>();

async function lookupUsername(userId: number): Promise<string | null> {
  const cached = usernameCache.get(userId);
  if (cached !== undefined) return cached;

  const row = await queryOne<{ username: string }>(
    'SELECT username FROM users WHERE id = $1', [userId]
  );

  if (row) {
    usernameCache.set(userId, row.username);
    return row.username;
  }
  return null;
}

/** Clear cache entry (e.g. after user rename). */
export function invalidateUsernameCache(userId?: number): void {
  if (userId !== undefined) {
    usernameCache.delete(userId);
  } else {
    usernameCache.clear();
  }
}

// ── Room Members Cache (TTL) ─────────────────────────────────────────
//
// Room message handling calls getMembers() on every single inbound message
// (for fan-out + @mention notifications). With 50 concurrent users this
// trampled the PG pool. Memoize the result for a short TTL (5s) and
// invalidate whenever members change.

const MEMBER_CACHE_TTL_MS = 5_000;
const memberCache = new Map<string, { expires: number; members: RoomMember[] }>();

function invalidateMemberCache(roomId?: string): void {
  if (roomId === undefined) {
    memberCache.clear();
  } else {
    memberCache.delete(roomId);
  }
}

/** Exported for callers that mutate members outside this module. */
export { invalidateMemberCache };

// ── Row → Domain Mappers ─────────────────────────────────────────────

function rowToRoom(r: any): Room {
  // Defensive: if kind column hasn't been migrated yet (very old prod restart
  // before 046 applied), default to 'user'. After 046 applies, the column
  // always has a NOT NULL value.
  const rawKind = r.kind;
  const kind: Room['kind'] = rawKind === 'tower_system'
    ? 'tower_system'
    : rawKind === 'personal_ai'
      ? 'personal_ai'
      : 'user';
  return {
    id: r.id,
    shortCode: r.short_code || undefined,
    name: r.name,
    description: r.description ?? null,
    roomType: r.room_type,
    kind,
    projectId: r.project_id ?? null,
    resourceLinks: Array.isArray(r.resource_links) ? r.resource_links : [],
    legacyOriginProjectId: r.legacy_origin_project_id ?? null,
    legacyOriginProjectName: r.legacy_origin_project_name ?? null,
    duplicateNameCount: Number(r.duplicate_name_count) || 0,
    invitedAgentNames: Array.isArray(r.invited_agent_names) ? r.invited_agent_names : [],
    avatarUrl: r.avatar_url ?? null,
    archived: !!r.archived,
    createdBy: r.created_by,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

async function rowToMessage(r: any): Promise<RoomMessage> {
  return {
    id: r.id,
    shortId: r.short_id || null,
    roomId: r.room_id,
    senderId: r.sender_id ?? null,
    senderName: r.sender_id != null ? await lookupUsername(r.sender_id) : null,
    seq: Number(r.seq),
    msgType: r.msg_type,
    content: r.content,
    metadata: r.metadata ?? {},
    taskId: r.task_id ?? null,
    replyTo: r.reply_to ?? null,
    editedAt: r.edited_at ? (r.edited_at instanceof Date ? r.edited_at.toISOString() : String(r.edited_at)) : null,
    deletedAt: r.deleted_at ? (r.deleted_at instanceof Date ? r.deleted_at.toISOString() : String(r.deleted_at)) : null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

async function rowToMember(r: any): Promise<RoomMember> {
  return {
    roomId: r.room_id,
    userId: r.user_id,
    username: (await lookupUsername(r.user_id)) ?? `user_${r.user_id}`,
    role: r.role,
    joinedAt: r.joined_at instanceof Date ? r.joined_at.toISOString() : String(r.joined_at),
    lastReadAt: r.last_read_at instanceof Date ? r.last_read_at.toISOString() : String(r.last_read_at ?? r.joined_at),
    invitedBy: r.invited_by ?? null,
    membershipSource: r.membership_source || 'legacy_unknown',
  };
}

// ── Room archive reads ───────────────────────────────────────────────


export async function getRoom(roomId: string): Promise<Room | null> {
  const { rows } = await getPgPool().query(
    `SELECT cr.*,
            origin.name AS legacy_origin_project_name,
            GREATEST((
              SELECT COUNT(*)::int - 1 FROM chat_rooms dup
               WHERE COALESCE(dup.archived, 0) = 0
                 AND COALESCE(dup.kind, 'user') = 'user'
                 AND lower(regexp_replace(trim(dup.name), '\\s+', ' ', 'g')) = lower(regexp_replace(trim(cr.name), '\\s+', ' ', 'g'))
            ), 0) AS duplicate_name_count,
            COALESCE((
              SELECT jsonb_agg(COALESCE(NULLIF(pap.display_name, ''), ap.name) ORDER BY cam.created_at)
                FROM channel_agent_memberships cam
                JOIN projects ap ON ap.id = cam.agent_project_id
                LEFT JOIN project_agent_profiles pap ON pap.project_id = ap.id
               WHERE cam.channel_id = cr.id
                 AND cam.revoked_at IS NULL
                 AND COALESCE(pap.status, 'active') IN ('active', 'ready')
            ), '[]'::jsonb) AS invited_agent_names,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'resourceType', crl.resource_type,
                'resourceId', crl.resource_id,
                'capability', crl.capability
              ) ORDER BY crl.created_at)
                FROM channel_resource_links crl
               WHERE crl.channel_id = cr.id AND crl.revoked_at IS NULL
            ), '[]'::jsonb) AS resource_links
       FROM chat_rooms cr
       LEFT JOIN projects origin ON origin.id = cr.legacy_origin_project_id
      WHERE cr.id = $1`,
    [roomId],
  );
  return rows.length > 0 ? rowToRoom(rows[0]) : null;
}

export async function listRooms(userId: number, role?: string): Promise<Room[]> {
  const pool = getPgPool();
  const userRole = role || (await queryOne<{ role: string }>('SELECT role FROM users WHERE id = $1', [userId]))?.role || 'member';
  const isAdmin = userRole === 'admin';

  // Listing is read-only: it never creates room membership. Privileged users
  // may inspect normal channels without being inserted into their audience.
  // Personal AI remains private-by-default and only surfaces to its owner/member.
  if (isAdmin) {
    const { rows } = await pool.query(
      `SELECT cr.*,
              origin.name AS legacy_origin_project_name,
              GREATEST((
                SELECT COUNT(*)::int - 1 FROM chat_rooms dup
                 WHERE COALESCE(dup.archived, 0) = 0
                   AND COALESCE(dup.kind, 'user') = 'user'
                   AND lower(regexp_replace(trim(dup.name), '\\s+', ' ', 'g')) = lower(regexp_replace(trim(cr.name), '\\s+', ' ', 'g'))
              ), 0) AS duplicate_name_count,
              COALESCE((
                SELECT jsonb_agg(COALESCE(NULLIF(pap.display_name, ''), ap.name) ORDER BY cam.created_at)
                  FROM channel_agent_memberships cam
                  JOIN projects ap ON ap.id = cam.agent_project_id
                  LEFT JOIN project_agent_profiles pap ON pap.project_id = ap.id
                 WHERE cam.channel_id = cr.id
                   AND cam.revoked_at IS NULL
                   AND COALESCE(pap.status, 'active') IN ('active', 'ready')
              ), '[]'::jsonb) AS invited_agent_names
         FROM chat_rooms cr
         LEFT JOIN projects origin ON origin.id = cr.legacy_origin_project_id
        WHERE (cr.archived IS NULL OR cr.archived = 0)
          AND (
            cr.kind IS DISTINCT FROM 'personal_ai'
            OR cr.created_by = $1
            OR EXISTS (
              SELECT 1 FROM room_members rm
               WHERE rm.room_id = cr.id AND rm.user_id = $1
            )
          )
        ORDER BY cr.updated_at DESC`,
      [userId],
    );
    return rows.map(rowToRoom);
  }

  // Non-admin: rooms where user is a member OR room belongs to an accessible project
  const accessibleIds = await getAccessibleProjectIds(userId, userRole);

  const { rows } = await pool.query(
    `SELECT cr.*,
            origin.name AS legacy_origin_project_name,
            GREATEST((
              SELECT COUNT(*)::int - 1 FROM chat_rooms dup
               WHERE COALESCE(dup.archived, 0) = 0
                 AND COALESCE(dup.kind, 'user') = 'user'
                 AND lower(regexp_replace(trim(dup.name), '\\s+', ' ', 'g')) = lower(regexp_replace(trim(cr.name), '\\s+', ' ', 'g'))
            ), 0) AS duplicate_name_count,
            COALESCE((
              SELECT jsonb_agg(COALESCE(NULLIF(pap.display_name, ''), ap.name) ORDER BY cam.created_at)
                FROM channel_agent_memberships cam
                JOIN projects ap ON ap.id = cam.agent_project_id
                LEFT JOIN project_agent_profiles pap ON pap.project_id = ap.id
               WHERE cam.channel_id = cr.id
                 AND cam.revoked_at IS NULL
                 AND COALESCE(pap.status, 'active') IN ('active', 'ready')
            ), '[]'::jsonb) AS invited_agent_names
       FROM chat_rooms cr
       LEFT JOIN projects origin ON origin.id = cr.legacy_origin_project_id
      WHERE (cr.archived IS NULL OR cr.archived = 0)
      ORDER BY cr.updated_at DESC`,
  );

  const visible = rows.filter(r => {
    // Room without project: must be explicit member (checked below)
    if (!r.project_id) return true;
    // Room with project: visible if user has project access
    if (accessibleIds === null) return true; // admin fallback
    return accessibleIds.includes(r.project_id);
  });

  if (visible.length === 0) return [];

  // Visibility is membership-based. Legacy project_id can no longer mutate or
  // grant membership merely because a user lists channels.
  const nonProjectRoomIds = visible.map(r => r.id);
  let memberSet = new Set<string>();
  if (nonProjectRoomIds.length > 0) {
    const { rows: memberRows } = await pool.query(
      `SELECT room_id FROM room_members WHERE user_id = $1 AND room_id = ANY($2::text[])`,
      [userId, nonProjectRoomIds],
    );
    memberSet = new Set(memberRows.map((row: { room_id: string }) => row.room_id));
  }

  // Preserve original updated_at DESC order from the initial SELECT.
  const result: Room[] = [];
  for (const room of visible) {
    if (memberSet.has(room.id)) result.push(rowToRoom(room));
  }

  return result;
}



// ── Membership archive reads ─────────────────────────────────────────



export interface RoomMembershipEvent {
  id: string;
  roomId: string;
  userId: number;
  username: string;
  eventType: 'joined' | 'rejoined' | 'left' | 'removed' | 'role_changed' | 'ownership_transferred' | 'legacy_backfilled';
  actorUserId: number | null;
  actorUsername: string | null;
  membershipSource: string | null;
  previousRole: string | null;
  nextRole: string | null;
  reason: string | null;
  createdAt: string;
}

/** List append-only membership events newest first for channel review/audit. */
export async function getMembershipEvents(roomId: string, limit = 100): Promise<RoomMembershipEvent[]> {
  const { rows } = await getPgPool().query(
    `SELECT e.*, target.username, actor.username AS actor_username
       FROM room_membership_events e
       JOIN users target ON target.id = e.user_id
       LEFT JOIN users actor ON actor.id = e.actor_user_id
      WHERE e.room_id = $1
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $2`,
    [roomId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map((row: any) => ({
    id: row.id,
    roomId: row.room_id,
    userId: row.user_id,
    username: row.username,
    eventType: row.event_type,
    actorUserId: row.actor_user_id ?? null,
    actorUsername: row.actor_username ?? null,
    membershipSource: row.membership_source ?? null,
    previousRole: row.previous_role ?? null,
    nextRole: row.next_role ?? null,
    reason: row.reason ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}

export async function getMembers(roomId: string): Promise<RoomMember[]> {
  const now = Date.now();
  const cached = memberCache.get(roomId);
  if (cached && cached.expires > now) {
    return cached.members;
  }

  const { rows } = await getPgPool().query(
    'SELECT * FROM room_members WHERE room_id = $1 ORDER BY joined_at ASC',
    [roomId],
  );
  const members = await Promise.all(rows.map(rowToMember));
  memberCache.set(roomId, { expires: now + MEMBER_CACHE_TTL_MS, members });
  return members;
}



export async function isMember(roomId: string, userId: number): Promise<boolean> {
  const { rows } = await getPgPool().query(
    'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
    [roomId, userId],
  );
  return rows.length > 0;
}

export async function getMemberRole(roomId: string, userId: number): Promise<string | null> {
  const { rows } = await getPgPool().query(
    'SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2',
    [roomId, userId],
  );
  return rows.length > 0 ? rows[0].role : null;
}

// ── Message archive reads ─────────────────────────────────────────────


export async function getMessages(
  roomId: string,
  options: { limit?: number; before?: string; after?: string } = {},
): Promise<RoomMessage[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  const conditions = ['room_id = $1', 'deleted_at IS NULL'];
  const vals: any[] = [roomId];
  let idx = 2;

  if (options.before) {
    // before = seq cursor
    conditions.push(`seq < $${idx++}`);
    vals.push(options.before);
  }
  if (options.after) {
    conditions.push(`seq > $${idx++}`);
    vals.push(options.after);
  }

  vals.push(limit);

  const { rows } = await getPgPool().query(
    `SELECT * FROM room_messages
     WHERE ${conditions.join(' AND ')}
     ORDER BY seq ASC
     LIMIT $${idx}`,
    vals,
  );
  return await Promise.all(rows.map(rowToMessage));
}



export async function getMessage(messageId: string): Promise<RoomMessage | null> {
  const { rows } = await getPgPool().query(
    'SELECT * FROM room_messages WHERE id = $1',
    [messageId],
  );
  return rows.length > 0 ? await rowToMessage(rows[0]) : null;
}

// ── Unread Counts ────────────────────────────────────────────────────

export async function getUnreadCounts(userId: number): Promise<Map<string, number>> {
  const { rows } = await getPgPool().query(
    `SELECT m.room_id, COUNT(msg.id)::INTEGER AS unread
     FROM room_members m
     JOIN room_messages msg
       ON msg.room_id = m.room_id
       AND msg.created_at > m.last_read_at
       AND msg.deleted_at IS NULL
     WHERE m.user_id = $1
     GROUP BY m.room_id`,
    [userId],
  );

  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.room_id, row.unread);
  }
  return counts;
}

// ── AI Context ───────────────────────────────────────────────────────


export async function getAiContexts(
  roomId: string,
  limit: number = 10,
): Promise<{ id: string; content: string; tokenCount: number; sourceTaskId: string | null; createdAt: string; expiresAt: string | null }[]> {
  const { rows } = await getPgPool().query(
    `SELECT id, content, token_count, source_task_id, created_at, expires_at
     FROM room_ai_context
     WHERE room_id = $1 AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC
     LIMIT $2`,
    [roomId, limit],
  );
  return rows.map((r: any) => ({
    id: r.id,
    content: r.content,
    tokenCount: r.token_count,
    sourceTaskId: r.source_task_id ?? null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    expiresAt: r.expires_at ? (r.expires_at instanceof Date ? r.expires_at.toISOString() : String(r.expires_at)) : null,
  }));
}


// ── Notifications ────────────────────────────────────────────────────

export async function createNotification(
  userId: number,
  roomId: string | null,
  type: string,
  title: string,
  body?: string,
  metadata?: Record<string, unknown>,
  options: {
    projectId?: string | null;
    sessionId?: string | null;
    priority?: string;
    actionUrl?: string | null;
    channels?: string[];
    deliveredChannels?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const id = uuidv4();
  await getPgPool().query(
    `INSERT INTO notifications
       (id, user_id, room_id, notif_type, title, body, metadata, project_id, session_id, priority, action_url, channels, delivered_channels)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::jsonb, $13::jsonb)`,
    [
      id,
      userId,
      roomId,
      type,
      title,
      body ?? null,
      JSON.stringify(metadata ?? {}),
      options.projectId ?? null,
      options.sessionId ?? null,
      options.priority ?? 'normal',
      options.actionUrl ?? null,
      JSON.stringify(options.channels ?? ['in_app']),
      JSON.stringify(options.deliveredChannels ?? {}),
    ],
  );
  return id;
}

/**
 * Batch notification insert — one round-trip for N recipients.
 * Returns array of { userId, notifId } in the same order as the input.
 *
 * Added 2026-04-10: previously, notifying N room members did N sequential
 * INSERTs. At 50 members this serialized into a multi-second critical path.
 */
export async function createNotificationsBatch(
  recipients: Array<{
    userId: number;
    roomId: string | null;
    type: string;
    title: string;
    body?: string;
    metadata?: Record<string, unknown>;
    options?: {
      projectId?: string | null;
      sessionId?: string | null;
      priority?: string;
      actionUrl?: string | null;
      channels?: string[];
      deliveredChannels?: Record<string, unknown>;
    };
  }>,
): Promise<Array<{ userId: number; notifId: string }>> {
  if (recipients.length === 0) return [];

  const rows: string[] = [];
  const vals: any[] = [];
  const result: Array<{ userId: number; notifId: string }> = [];
  let i = 1;
  for (const r of recipients) {
    const id = uuidv4();
    result.push({ userId: r.userId, notifId: id });
    rows.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}::jsonb, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}::jsonb, $${i++}::jsonb)`);
    vals.push(
      id,
      r.userId,
      r.roomId,
      r.type,
      r.title,
      r.body ?? null,
      JSON.stringify(r.metadata ?? {}),
      r.options?.projectId ?? null,
      r.options?.sessionId ?? null,
      r.options?.priority ?? 'normal',
      r.options?.actionUrl ?? null,
      JSON.stringify(r.options?.channels ?? ['in_app']),
      JSON.stringify(r.options?.deliveredChannels ?? {}),
    );
  }

  await getPgPool().query(
    `INSERT INTO notifications
       (id, user_id, room_id, notif_type, title, body, metadata, project_id, session_id, priority, action_url, channels, delivered_channels)
     VALUES ${rows.join(', ')}`,
    vals,
  );
  return result;
}

export async function getNotifications(
  userId: number,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<any[]> {
  const limit = options.limit ?? 50;
  const conditions = ['user_id = $1', 'dismissed_at IS NULL'];
  const vals: any[] = [userId];

  if (options.unreadOnly) {
    conditions.push('read = 0');
  }

  vals.push(limit);

  const { rows } = await getPgPool().query(
    `SELECT * FROM notifications
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${vals.length}`,
    vals,
  );
  return rows.map((r: any) => ({
    id: r.id,
    userId: r.user_id,
    roomId: r.room_id,
    projectId: r.project_id ?? null,
    sessionId: r.session_id ?? null,
    type: r.notif_type,
    title: r.title,
    body: r.body,
    metadata: r.metadata ?? {},
    priority: r.priority ?? 'normal',
    actionUrl: r.action_url ?? null,
    channels: r.channels ?? ['in_app'],
    deliveredChannels: r.delivered_channels ?? {},
    read: !!r.read,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

export async function markNotificationRead(notifId: string, userId?: number): Promise<boolean> {
  const sql = userId
    ? 'UPDATE notifications SET read = 1 WHERE id = $1 AND user_id = $2'
    : 'UPDATE notifications SET read = 1 WHERE id = $1';
  const params: any[] = userId ? [notifId, userId] : [notifId];
  const { rowCount } = await getPgPool().query(sql, params);
  return (rowCount ?? 0) > 0;
}

export async function markAllNotificationsRead(userId: number): Promise<number> {
  const { rowCount } = await getPgPool().query(
    'UPDATE notifications SET read = 1 WHERE user_id = $1 AND read = 0',
    [userId],
  );
  return rowCount ?? 0;
}

export async function getUnreadCount(userId: number): Promise<number> {
  const { rows } = await getPgPool().query(
    'SELECT COUNT(*)::int AS cnt FROM notifications WHERE user_id = $1 AND read = 0',
    [userId],
  );
  return rows[0].cnt;
}
