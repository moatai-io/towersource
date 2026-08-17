/**
 * Room Manager — PostgreSQL-backed room CRUD + PgAdapter implementation.
 *
 * All room data (chat_rooms, room_members, room_messages, room_ai_context,
 * notifications, attachments) lives in PG.  User data lives in SQLite.
 * This module bridges the two.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPgPool } from '../../db/pg.js';
import { queryOne, query, execute } from '../../db/pg-repo.js';
import { getAccessibleProjectIds } from '../pm/project-membership-manager.js';
import { generateShortCode } from '../session/short-code.js';

const PG_UNIQUE_VIOLATION = '23505';
const SHORT_CODE_MAX_RETRIES = 5;
const CHANNEL_NAME_CONFLICT_CODE = 'CHANNEL_NAME_CONFLICT';

export class ChannelNameConflictError extends Error {
  code = CHANNEL_NAME_CONFLICT_CODE;
  existingRoomId: string;
  existingRoomName: string;

  constructor(existingRoom: { id: string; name: string }) {
    super(`An active channel named "${existingRoom.name}" already exists`);
    this.name = 'ChannelNameConflictError';
    this.existingRoomId = existingRoom.id;
    this.existingRoomName = existingRoom.name;
  }
}

/** Normalize channel labels for human-facing duplicate detection. */
export function normalizeChannelName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

async function assertActiveUserChannelNameAvailable(name: string, excludeRoomId?: string): Promise<void> {
  const normalized = normalizeChannelName(name);
  if (!normalized) throw new Error('Channel name is required');
  const existing = await queryOne<{ id: string; name: string }>(
    `SELECT id, name FROM chat_rooms
      WHERE COALESCE(archived, 0) = 0
        AND COALESCE(kind, 'user') = 'user'
        AND lower(regexp_replace(trim(name), '\\s+', ' ', 'g')) = $1
        AND ($2::text IS NULL OR id <> $2)
      ORDER BY created_at ASC LIMIT 1`,
    [normalized, excludeRoomId ?? null],
  );
  if (existing) throw new ChannelNameConflictError(existing);
}

// ── Types ────────────────────────────────────────────────────────────

export interface Room {
  id: string;
  /**
   * URL-friendly short code (8자 base32) — `/r/<shortCode>` 형태로 채널 deep link.
   * 마이그레이션 070 적용 후 신규 채널은 항상 발급, 기존은 부팅 시 backfill.
   * 결정: issue #11 Phase 2 확장 (sessions.short_code 와 동일 패턴).
   */
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
  /**
   * URL anchor token (8자 base32) — `/r/<roomShortCode>#m-<shortId>` 형태.
   * (room_id, short_id) composite unique — 채널 안에서만 unique.
   * 마이그레이션 071 적용 후 신규 메시지는 항상 발급, 기존은 부팅 시 backfill.
   * 결정: issue #11 Phase 3 채널 메시지 앵커.
   */
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

// ── Validation Helpers ───────────────────────────────────────────────

const VALID_ROOM_TYPES = new Set(['team', 'project', 'dashboard']);
const VALID_MEMBER_ROLES = new Set(['owner', 'admin', 'member', 'readonly']);
const VALID_MSG_TYPES = new Set(['human', 'ai_summary', 'ai_task_ref', 'ai_error', 'ai_reply', 'system', 'webhook']);

function assertRoomType(v: string): asserts v is Room['roomType'] {
  if (!VALID_ROOM_TYPES.has(v)) throw new Error(`Invalid room type: ${v}`);
}

function assertMemberRole(v: string): asserts v is RoomMember['role'] {
  if (!VALID_MEMBER_ROLES.has(v)) throw new Error(`Invalid member role: ${v}`);
}

function assertMsgType(v: string): asserts v is RoomMessage['msgType'] {
  if (!VALID_MSG_TYPES.has(v)) throw new Error(`Invalid message type: ${v}`);
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

// ── Room CRUD ────────────────────────────────────────────────────────

export async function createRoom(
  name: string,
  description: string | null,
  roomType: string,
  createdBy: number,
  projectId?: string,
): Promise<Room> {
  assertRoomType(roomType);
  await assertActiveUserChannelNameAvailable(name);
  const pool = getPgPool();

  // INSERT with short_code — sessions.short_code 와 같은 8자 코드 정책.
  // unique 충돌은 거의 없지만 partial unique index 위반 시 최대 5회 재시도.
  let room: Room | null = null;
  for (let attempt = 0; attempt < SHORT_CODE_MAX_RETRIES; attempt++) {
    const shortCode = generateShortCode();
    try {
      const { rows } = await pool.query(
        `INSERT INTO chat_rooms (short_code, name, description, room_type, project_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [shortCode, name, description, roomType, projectId ?? null, createdBy],
      );
      room = rowToRoom(rows[0]);
      break;
    } catch (err: any) {
      if (err?.code === PG_UNIQUE_VIOLATION && attempt < SHORT_CODE_MAX_RETRIES - 1) continue;
      throw err;
    }
  }
  if (!room) throw new Error('Failed to create room with short_code');

  // Auto-add creator as owner
  await pool.query(
    `INSERT INTO room_members (room_id, user_id, role, invited_by, membership_source)
     VALUES ($1, $2, 'owner', $2, 'creator')`,
    [room.id, createdBy],
  );
  await pool.query(
    `INSERT INTO room_membership_events (
       room_id, user_id, event_type, actor_user_id, membership_source, next_role, reason
     ) VALUES ($1, $2, 'joined', $2, 'creator', 'owner', 'Channel created')`,
    [room.id, createdBy],
  );
  invalidateMemberCache(room.id);

  // Legacy callers may still pass projectId. Preserve its old member-seeding
  // behavior, but represent the project only as a context link and clear room
  // ownership before returning the new people-centered channel.
  if (projectId) {
    await pool.query(
      `INSERT INTO channel_resource_links (
         channel_id, resource_type, resource_id, capability, added_by
       ) VALUES ($1, 'project', $2, 'read', $3)
       ON CONFLICT (channel_id, resource_type, resource_id) DO NOTHING`,
      [room.id, projectId, createdBy],
    );
    room.resourceLinks = [{ resourceType: 'project', resourceId: projectId, capability: 'read' }];
  }

  // Auto-add project members for compatibility with project-origin creation.
  if (projectId) {
    try {
      const { getProjectMembers } = await import('../pm/project-membership-manager.js');
      const members = await getProjectMembers(projectId);
      for (const m of members) {
        if (m.userId === createdBy) continue; // already owner
        const added = await pool.query(
          `INSERT INTO room_members (room_id, user_id, role, invited_by, membership_source)
           VALUES ($1, $2, 'member', $3, 'legacy_project_backfill')
           ON CONFLICT (room_id, user_id) DO NOTHING
           RETURNING room_id`,
          [room.id, m.userId, createdBy],
        );
        if ((added.rowCount ?? 0) > 0) {
          await pool.query(
            `INSERT INTO room_membership_events (
               room_id, user_id, event_type, actor_user_id, membership_source, next_role, reason
             ) VALUES ($1, $2, 'joined', $3, 'legacy_project_backfill', 'member', 'Legacy Project-origin channel creation')`,
            [room.id, m.userId, createdBy],
          );
        }
      }
    } catch (err: any) {
      console.error(`[room-manager] Failed to auto-add project members:`, err.message);
    }
  }

  if (projectId) {
    await pool.query('UPDATE chat_rooms SET project_id = NULL WHERE id = $1', [room.id]);
    room.projectId = null;
  }

  // Ensure cache reflects the final member roster for the new room.
  invalidateMemberCache(room.id);

  return room;
}

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

/** URL key (short_code or UUID) 로 채널 1건 조회. `/r/<key>` 라우팅용. */
export async function getRoomByKey(key: string): Promise<Room | null> {
  const isUuidLike = key.length === 36 && key.includes('-');
  const rows = await query<any>(
    isUuidLike ? 'SELECT * FROM chat_rooms WHERE id = $1' : 'SELECT * FROM chat_rooms WHERE short_code = $1',
    [key],
  );
  return rows.length > 0 ? rowToRoom(rows[0]) : null;
}

/**
 * 부팅 시 room_messages.short_id 가 NULL 인 기존 채널 메시지를 backfill.
 * 500-row batch fire-and-forget. (room_id, short_id) composite unique 라
 * 충돌 risk 거의 0.
 */
export async function backfillRoomMessageShortIds(batchSize: number = 500): Promise<number> {
  let totalUpdated = 0;
  while (true) {
    const rows = await query<{ id: string }>(
      'SELECT id FROM room_messages WHERE short_id IS NULL LIMIT $1',
      [batchSize],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      for (let attempt = 0; attempt < SHORT_CODE_MAX_RETRIES; attempt++) {
        const code = generateShortCode();
        try {
          await execute(
            'UPDATE room_messages SET short_id = $1 WHERE id = $2 AND short_id IS NULL',
            [code, row.id],
          );
          totalUpdated++;
          break;
        } catch (err: any) {
          if (err?.code === PG_UNIQUE_VIOLATION && attempt < SHORT_CODE_MAX_RETRIES - 1) continue;
          console.warn(`[room-manager] backfillRoomMessageShortIds: row ${row.id} failed:`, err?.message);
          break;
        }
      }
    }
  }
  return totalUpdated;
}

/** 부팅 시 chat_rooms.short_code 가 NULL 인 기존 채널을 backfill. */
export async function backfillRoomShortCodes(): Promise<number> {
  const rows = await query<{ id: string }>('SELECT id FROM chat_rooms WHERE short_code IS NULL', []);
  if (rows.length === 0) return 0;

  let updated = 0;
  for (const row of rows) {
    for (let attempt = 0; attempt < SHORT_CODE_MAX_RETRIES; attempt++) {
      const code = generateShortCode();
      try {
        await execute(
          'UPDATE chat_rooms SET short_code = $1 WHERE id = $2 AND short_code IS NULL',
          [code, row.id],
        );
        updated++;
        break;
      } catch (err: any) {
        if (err?.code === PG_UNIQUE_VIOLATION && attempt < SHORT_CODE_MAX_RETRIES - 1) continue;
        throw err;
      }
    }
  }
  return updated;
}

export async function listRooms(userId: number, role?: string): Promise<Room[]> {
  const pool = getPgPool();
  const userRole = role || (await queryOne<{ role: string }>('SELECT role FROM users WHERE id = $1', [userId]))?.role || 'member';
  const isAdmin = userRole === 'admin';

  // 2026-04-10 (100-user scale): this function used to do N+1 queries per
  // sidebar load (one INSERT per room for auto-join, plus one SELECT per
  // non-project room for membership). For 100 users × 50 rooms that was
  // ~5000 sequential round-trips. Rewritten to use batched multi-row
  // INSERT + single batched SELECT below.

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

export async function updateRoom(
  roomId: string,
  updates: { name?: string; description?: string; archived?: boolean; projectId?: string | null },
): Promise<Room | null> {
  const sets: string[] = [];
  const vals: any[] = [];
  let idx = 1;

  if (updates.name !== undefined) {
    await assertActiveUserChannelNameAvailable(updates.name, roomId);
    sets.push(`name = $${idx++}`);
    vals.push(updates.name.trim().replace(/\s+/g, ' '));
  }
  if (updates.description !== undefined) {
    sets.push(`description = $${idx++}`);
    vals.push(updates.description);
  }
  if (updates.archived !== undefined) {
    sets.push(`archived = $${idx++}`);
    vals.push(updates.archived ? 1 : 0);  // column is INTEGER, not BOOLEAN
  }
  // projectId is no longer channel ownership. Legacy PATCH callers must use
  // the resource-link endpoints instead of moving a channel between projects.

  if (sets.length === 0) return getRoom(roomId);

  sets.push(`updated_at = NOW()`);
  vals.push(roomId);

  const { rows } = await getPgPool().query(
    `UPDATE chat_rooms SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    vals,
  );
  return rows.length > 0 ? rowToRoom(rows[0]) : null;
}

export async function deleteRoom(roomId: string): Promise<boolean> {
  const { rowCount } = await getPgPool().query(
    'DELETE FROM chat_rooms WHERE id = $1',
    [roomId],
  );
  invalidateMemberCache(roomId);
  return (rowCount ?? 0) > 0;
}

// ── Members ──────────────────────────────────────────────────────────

export async function addMember(
  roomId: string,
  userId: number,
  role: string = 'member',
  audit: { actorUserId?: number | null; source?: RoomMember['membershipSource']; reason?: string } = {},
): Promise<RoomMember> {
  assertMemberRole(role);
  const pool = getPgPool();
  const existing = await pool.query('SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
  const hadHistory = await pool.query('SELECT 1 FROM room_membership_events WHERE room_id = $1 AND user_id = $2 LIMIT 1', [roomId, userId]);
  const source = audit.source || 'manual_invite';
  const { rows } = await pool.query(
    `INSERT INTO room_members (room_id, user_id, role, invited_by, membership_source)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (room_id, user_id) DO UPDATE SET
       role = EXCLUDED.role,
       invited_by = EXCLUDED.invited_by,
       membership_source = EXCLUDED.membership_source
     RETURNING *`,
    [roomId, userId, role, audit.actorUserId ?? null, source],
  );
  if (existing.rowCount === 0) {
    await pool.query(
      `INSERT INTO room_membership_events (
         room_id, user_id, event_type, actor_user_id, membership_source, next_role, reason
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [roomId, userId, hadHistory.rowCount ? 'rejoined' : 'joined', audit.actorUserId ?? null, source, role, audit.reason ?? null],
    );
  } else if (existing.rows[0].role !== role) {
    await pool.query(
      `INSERT INTO room_membership_events (
         room_id, user_id, event_type, actor_user_id, membership_source, previous_role, next_role, reason
       ) VALUES ($1, $2, 'role_changed', $3, $4, $5, $6, $7)`,
      [roomId, userId, audit.actorUserId ?? null, source, existing.rows[0].role, role, audit.reason ?? null],
    );
  }
  invalidateMemberCache(roomId);
  return await rowToMember(rows[0]);
}

export async function removeMember(
  roomId: string,
  userId: number,
  audit: { actorUserId?: number | null; reason?: string; selfLeave?: boolean } = {},
): Promise<boolean> {
  const pool = getPgPool();
  const removed = await pool.query(
    'DELETE FROM room_members WHERE room_id = $1 AND user_id = $2 RETURNING role, membership_source',
    [roomId, userId],
  );
  if ((removed.rowCount ?? 0) > 0) {
    const row = removed.rows[0];
    await pool.query(
      `INSERT INTO room_membership_events (
         room_id, user_id, event_type, actor_user_id, membership_source, previous_role, reason
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [roomId, userId, audit.selfLeave ? 'left' : 'removed', audit.actorUserId ?? null, row.membership_source, row.role, audit.reason ?? null],
    );
  }
  invalidateMemberCache(roomId);
  return (removed.rowCount ?? 0) > 0;
}

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

export async function updateMemberRole(
  roomId: string,
  userId: number,
  role: string,
  audit: { actorUserId?: number | null; reason?: string } = {},
): Promise<boolean> {
  assertMemberRole(role);
  const pool = getPgPool();
  const current = await pool.query(
    'SELECT role, membership_source FROM room_members WHERE room_id = $1 AND user_id = $2',
    [roomId, userId],
  );
  if (current.rowCount === 0 || current.rows[0].role === role) return false;
  const changed = await pool.query(
    `UPDATE room_members SET role = $1
      WHERE room_id = $2 AND user_id = $3
      RETURNING membership_source`,
    [role, roomId, userId],
  );
  if ((changed.rowCount ?? 0) > 0) {
    await pool.query(
      `INSERT INTO room_membership_events (
         room_id, user_id, event_type, actor_user_id, membership_source, previous_role, next_role, reason
       ) VALUES ($1, $2, 'role_changed', $3, $4, $5, $6, $7)`,
      [roomId, userId, audit.actorUserId ?? null, changed.rows[0].membership_source, current.rows[0].role, role, audit.reason ?? null],
    );
  }
  invalidateMemberCache(roomId);
  return (changed.rowCount ?? 0) > 0;
}

export async function updateLastRead(roomId: string, userId: number): Promise<void> {
  await getPgPool().query(
    'UPDATE room_members SET last_read_at = NOW() WHERE room_id = $1 AND user_id = $2',
    [roomId, userId],
  );
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

// ── Messages ─────────────────────────────────────────────────────────

export async function sendMessage(
  roomId: string,
  senderId: number | null,
  content: string,
  msgType: string = 'human',
  metadata: Record<string, unknown> = {},
  taskId?: string,
  replyTo?: string,
): Promise<RoomMessage> {
  assertMsgType(msgType);
  // short_id with retry — (room_id, short_id) composite unique. 채널 안에서만
  // 충돌 검사하므로 birthday risk 거의 0.  결정: issue #11 Phase 3 채널 앵커.
  const pool = getPgPool();
  for (let attempt = 0; attempt < SHORT_CODE_MAX_RETRIES; attempt++) {
    const shortId = generateShortCode();
    try {
      const { rows } = await pool.query(
        `INSERT INTO room_messages (room_id, sender_id, msg_type, content, metadata, task_id, reply_to, short_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         RETURNING *`,
        [roomId, senderId, msgType, content, JSON.stringify(metadata), taskId ?? null, replyTo ?? null, shortId],
      );
      return await rowToMessage(rows[0]);
    } catch (err: any) {
      if (err?.code === PG_UNIQUE_VIOLATION && attempt < SHORT_CODE_MAX_RETRIES - 1) continue;
      throw err;
    }
  }
  throw new Error('Failed to send message with short_id');
}

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

export async function editMessage(messageId: string, content: string): Promise<RoomMessage | null> {
  const { rows } = await getPgPool().query(
    `UPDATE room_messages SET content = $1, edited_at = NOW()
     WHERE id = $2 AND deleted_at IS NULL
     RETURNING *`,
    [content, messageId],
  );
  return rows.length > 0 ? await rowToMessage(rows[0]) : null;
}

export async function deleteMessage(messageId: string): Promise<boolean> {
  const { rowCount } = await getPgPool().query(
    'UPDATE room_messages SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL',
    [messageId],
  );
  return (rowCount ?? 0) > 0;
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

// ── AI Session (Persistent Channel AI) ──────────────────────────────
// Channel AI sessions live in the sessions table with label = 'channel_ai'.
// The chat_rooms table stores ai_engine_session_id as a cache for quick resume.

export interface ChannelAiSession {
  sessionId: string;          // Tower session ID (sessions table)
  engineSessionId: string | null;  // SDK session ID (for resume)
  messageCount: number;
  /**
   * Pinned CLAUDE_CONFIG_DIR for this channel session (PR-1, 2026-05-09).
   * NULL = no pinned dir; caller falls back to runtime getConfigDir lookup.
   * Forwarded to channelReply so the SDK spawn + backup land in the correct
   * account directory (e.g. ~/.claude-gmail/ for gmail-account projects).
   */
  configDir: string | null;
  /** Authority snapshot bound to the resumable engine context. */
  authorityFingerprint: string | null;
}

/**
 * Get or create the persistent channel AI session for a room.
 * Looks up sessions table first; falls back to chat_rooms cache.
 */
export async function getOrCreateChannelAiSession(
  roomId: string,
  roomName: string,
  userId: number,
  projectId: string | null,
  engine: string,
  projectRootPath?: string,
  agentProjectId?: string | null,
  agentDisplayName?: string,
  modelUsed?: string | null,
): Promise<ChannelAiSession> {
  const pool = getPgPool();

  // 1. Look up existing channel_ai session in sessions table.
  //    NOTE: we deliberately include archived rows. If a user accidentally
  //    deleted the channel session from the sidebar (delete = soft-delete,
  //    archived=1), the conversation history is still intact — we RESURRECT it
  //    instead of creating a fresh empty session (which is what made channel AI
  //    threads "disappear"). An explicit "@ai /reset" relabels the session to
  //    'channel_ai_reset' (see clearChannelAiSession), so a reset is correctly
  //    excluded from this lookup and a brand-new session is created.
  //    결정: workspace/decisions/2026-05-23-channel-ai-session-isolation.md
  const sessionLabel = agentProjectId ? 'channel_agent' : 'channel_ai';
  const { rows } = await pool.query(
    `SELECT id, claude_session_id, pi_session_file, engine, turn_count, config_dir, archived, channel_authority_fingerprint
       FROM sessions
      WHERE room_id = $1
        AND label = $2
        AND (($3::text IS NULL AND channel_agent_project_id IS NULL) OR channel_agent_project_id = $3)
      ORDER BY updated_at DESC LIMIT 1`,
    [roomId, sessionLabel, agentProjectId ?? null],
  );

  if (rows.length > 0) {
    // Resurrect if it was archived by an accidental sidebar delete.
    if (rows[0].archived === 1) {
      await pool.query(
        `UPDATE sessions SET archived = 0, updated_at = NOW() WHERE id = $1`,
        [rows[0].id],
      );
      console.log(`[room-manager] Resurrected archived ${sessionLabel} session ${rows[0].id} for room ${roomId}`);
    }
    return {
      sessionId: rows[0].id,
      engineSessionId: rows[0].engine === 'pi'
        ? rows[0].pi_session_file ?? null
        : rows[0].claude_session_id ?? null,
      messageCount: rows[0].turn_count ?? 0,
      configDir: rows[0].config_dir ?? null,
      authorityFingerprint: rows[0].channel_authority_fingerprint ?? null,
    };
  }

  // 2. No session exists — create one
  // Owner is null (system-owned) — channel AI is a shared team resource, not owned by any individual.
  // Visibility is 'project' so all project members can see it.
  // cwd priority: explicit project rootPath → backend process cwd (never the old hardcoded
  // '/home/tower' — breaks on self-hosted servers like demo-org where the home dir differs).
  const { createSession, updateSession } = await import('../session/session-manager.js');
  const sessionCwd = projectRootPath || process.cwd();
  const session = await createSession(
    agentDisplayName ? `${agentDisplayName} · #${roomName}` : `🤖 ${roomName}`,
    sessionCwd,
    undefined,             // shared channel session, not an individual's private thread
    projectId,
    engine,
    roomId,
    undefined,
    undefined,
    sessionLabel,
    modelUsed,
  );
  await updateSession(session.id, { label: sessionLabel, visibility: 'project' });
  if (agentProjectId) {
    await pool.query(
      `UPDATE sessions
          SET channel_agent_project_id = $2,
              project_agent_profile_snapshot = NULL,
              project_id = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [session.id, agentProjectId],
    );
    const { getSessionProjectAgentRuntimeProfile } = await import('../pm/project-agent-profile.js');
    await getSessionProjectAgentRuntimeProfile(session.id, agentProjectId);
  }

  // session.configDir was pinned in createSession via getConfigDir(projectId).
  // Forward it so the channel's first turn lands in the correct account dir.
  return {
    sessionId: session.id,
    engineSessionId: null,
    messageCount: 0,
    configDir: session.configDir ?? null,
    authorityFingerprint: null,
  };
}

/**
 * Update channel AI session after a successful reply.
 * Syncs both sessions table and chat_rooms cache.
 */
export async function updateChannelAiSession(
  roomId: string,
  sessionId: string,
  engineSessionId: string,
  authorityFingerprint?: string,
): Promise<void> {
  const pool = getPgPool();

  // Update sessions table
  const { claimEngineSessionId, getSession, updateSession } = await import('../session/session-manager.js');
  const session = await getSession(sessionId);
  await claimEngineSessionId(sessionId, session?.engine, engineSessionId);
  await updateSession(sessionId, {
    turnCount: undefined,  // will be incremented below
  });

  // Increment turn count
  await pool.query(
    `UPDATE sessions
        SET turn_count = COALESCE(turn_count, 0) + 1,
            channel_authority_fingerprint = COALESCE($2, channel_authority_fingerprint),
            updated_at = NOW()
      WHERE id = $1`,
    [sessionId, authorityFingerprint ?? null],
  );

  // Sync chat_rooms cache
  await pool.query(
    `UPDATE chat_rooms
     SET ai_engine_session_id = $2,
         ai_session_created_at = COALESCE(ai_session_created_at, NOW()),
         ai_session_message_count = COALESCE(ai_session_message_count, 0) + 1
     WHERE id = $1`,
    [roomId, engineSessionId],
  );
}

/**
 * Clear channel AI session (on @ai /reset).
 * Archives the session and clears the room cache.
 */
export async function clearChannelAiSession(roomId: string): Promise<void> {
  const pool = getPgPool();

  // Archive existing channel_ai session(s) AND relabel them to
  // 'channel_ai_reset'. The relabel is what makes a /reset distinct from an
  // accidental sidebar delete: getOrCreateChannelAiSession only resurrects
  // rows still labeled 'channel_ai', so a reset session is left archived and a
  // brand-new conversation starts. Data is preserved either way (soft-delete).
  // 결정: workspace/decisions/2026-05-23-channel-ai-session-isolation.md
  await pool.query(
    `UPDATE sessions SET archived = 1, label = 'channel_ai_reset', updated_at = NOW()
     WHERE room_id = $1 AND label = 'channel_ai' AND (archived IS NULL OR archived = 0)`,
    [roomId],
  );

  // Clear room cache
  await pool.query(
    `UPDATE chat_rooms
     SET ai_engine_session_id = NULL,
         ai_session_created_at = NULL,
         ai_session_message_count = 0
     WHERE id = $1`,
    [roomId],
  );
}

// ── AI Context ───────────────────────────────────────────────────────

export async function saveAiContext(
  roomId: string,
  content: string,
  tokenCount: number,
  sourceTaskId: string,
): Promise<string> {
  const { rows } = await getPgPool().query(
    `INSERT INTO room_ai_context (room_id, context_type, content, token_count, source_task_id)
     VALUES ($1, 'task_summary', $2, $3, $4)
     RETURNING id`,
    [roomId, content, tokenCount, sourceTaskId],
  );
  return rows[0].id;
}

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

export async function cleanupExpiredContexts(): Promise<number> {
  const { rowCount } = await getPgPool().query(
    'DELETE FROM room_ai_context WHERE expires_at IS NOT NULL AND expires_at <= NOW()',
  );
  return rowCount ?? 0;
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
