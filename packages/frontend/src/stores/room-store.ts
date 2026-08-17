import { create } from 'zustand';

// ── Types ──────────────────────────────────────────────────────────

export interface Room {
  id: string;
  /** URL-friendly short code for future `/r/<shortCode>` channel deep links. */
  shortCode?: string;
  name: string;
  description: string | null;
  roomType: 'team' | 'project' | 'dashboard';
  /**
   * 'user' (default) — normal user-created room.
   * 'tower_system'   — workspace-wide AI channel (Tower persona).
   * 'personal_ai'    — user-private AI/Noti channel by default.
   * Optional for forward compat with older API responses; absence ⇒ 'user'.
   * See: workspace/decisions/2026-05-04-tower-channel-and-persona.md
   */
  kind?: 'user' | 'tower_system' | 'personal_ai';
  /** Legacy primary project while channels migrate to 0..N resource links. */
  projectId: string | null;
  resourceLinks?: Array<{
    resourceType: 'project';
    resourceId: string;
    capability: 'discover' | 'read' | 'write';
  }>;
  /** Historical Project origin before channels became people-centered. */
  legacyOriginProjectId?: string | null;
  legacyOriginProjectName?: string | null;
  /** Other active user channels sharing this normalized name. */
  duplicateNameCount?: number;
  /** Current invited Primary Agent display names. */
  invitedAgentNames?: string[];
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
  invitedBy?: number | null;
  membershipSource?: 'creator' | 'manual_invite' | 'legacy_project_backfill' | 'system' | 'legacy_unknown';
}

export interface RoomMessage {
  id: string;
  /**
   * URL anchor token (8자 base32) — `/r/<roomShortCode>#m-<shortId>` 형태로
   * 채널 메시지 직접 링크. (room_id, short_id) composite unique — 채널 안에서만.
   * 마이그 071 이후 신규는 자동 부여, 기존은 부팅 시 backfill. NULL 가능.
   * 결정: issue #11 Phase 3 채널 앵커.
   */
  shortId?: string | null;
  roomId: string;
  senderId: number | null;
  senderName: string | null;
  seq: number;
  msgType: 'human' | 'ai_summary' | 'ai_task_ref' | 'ai_error' | 'ai_reply' | 'system';
  content: string;
  metadata: Record<string, unknown>;
  taskId: string | null;
  replyTo: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  // Optimistic send fields (client-only, not persisted)
  pending?: boolean;
  failed?: boolean;
  clientMsgId?: string;
}

export interface TypingUser {
  userId: number;
  username: string;
  timestamp: number; // Date.now() when typing started
}

export interface RoomNotification {
  id: string;
  userId: number;
  roomId: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  type: string;
  title: string;
  body: string | null;
  metadata: Record<string, unknown>;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  actionUrl?: string | null;
  channels?: Array<'in_app' | 'toast' | 'web_push'>;
  deliveredChannels?: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

// ── Typing timeout tracking (outside zustand to avoid serialization issues) ──

const typingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

function typingKey(roomId: string, userId: number): string {
  return `${roomId}:${userId}`;
}

// ── Store ──────────────────────────────────────────────────────────

interface RoomState {
  // Room list
  rooms: Room[];
  activeRoomId: string | null;

  // Messages per room (keyed by roomId)
  messagesByRoom: Record<string, RoomMessage[]>;

  // Members per room
  membersByRoom: Record<string, RoomMember[]>;

  // Unread counts per room
  unreadCounts: Record<string, number>;

  // Typing indicators per room
  typingByRoom: Record<string, TypingUser[]>;

  // Notifications
  notifications: RoomNotification[];
  unreadNotifCount: number;

  // Loading states
  loading: boolean;
  messagesLoading: boolean;

  // PG availability flag
  pgEnabled: boolean;

  // ── Actions ──────────────────────────────────────────────────────

  // Rooms
  setRooms: (rooms: Room[]) => void;
  addRoom: (room: Room) => void;
  updateRoom: (roomId: string, updates: Partial<Room>) => void;
  removeRoom: (roomId: string) => void;
  setActiveRoomId: (roomId: string | null) => void;

  // Messages
  setMessages: (roomId: string, messages: RoomMessage[]) => void;
  addMessage: (roomId: string, message: RoomMessage) => void;
  prependMessages: (roomId: string, messages: RoomMessage[]) => void;
  updateMessage: (roomId: string, messageId: string, updates: Partial<RoomMessage>) => void;
  /**
   * 한 채널의 여러 메시지 shortId 한 번에 patch (issue #11 채널 메시지 앵커).
   * AnchorLinkAction 의 lazy fetch 패턴 — optimistic 메시지의 shortId 채움.
   */
  patchMessageShortIds: (roomId: string, updates: Array<{ id: string; shortId: string }>) => void;
  removeMessage: (roomId: string, messageId: string) => void;
  confirmPendingMessage: (roomId: string, clientMsgId: string, serverMessage: RoomMessage) => void;
  markMessageFailed: (roomId: string, clientMsgId: string) => void;

  // Members
  setMembers: (roomId: string, members: RoomMember[]) => void;
  addMember: (roomId: string, member: RoomMember) => void;
  removeMember: (roomId: string, userId: number) => void;

  // Unread
  setUnreadCounts: (counts: Record<string, number>) => void;
  incrementUnread: (roomId: string) => void;
  clearUnread: (roomId: string) => void;

  // Typing
  setTyping: (roomId: string, user: TypingUser) => void;
  clearTyping: (roomId: string, userId: number) => void;

  // Notifications
  setNotifications: (notifications: RoomNotification[]) => void;
  addNotification: (notification: RoomNotification) => void;
  markNotificationRead: (notifId: string) => void;
  markAllNotificationsRead: () => void;
  setUnreadNotifCount: (count: number) => void;

  // Loading
  setLoading: (loading: boolean) => void;
  setMessagesLoading: (loading: boolean) => void;

  // PG
  setPgEnabled: (enabled: boolean) => void;

  // Channel project grouping (collapsed state)
  collapsedRoomGroups: Set<string>;
  toggleRoomGroupCollapsed: (groupId: string) => void;
}

// Persist collapsed room groups in localStorage
function loadCollapsedRoomGroups(): Set<string> {
  try {
    const raw = localStorage.getItem('collapsedRoomGroups');
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

function saveCollapsedRoomGroups(s: Set<string>) {
  localStorage.setItem('collapsedRoomGroups', JSON.stringify([...s]));
}

export const useRoomStore = create<RoomState>((set, get) => ({
  rooms: [],
  activeRoomId: null,
  messagesByRoom: {},
  membersByRoom: {},
  unreadCounts: {},
  typingByRoom: {},
  notifications: [],
  unreadNotifCount: 0,
  loading: false,
  messagesLoading: false,
  pgEnabled: false,
  collapsedRoomGroups: loadCollapsedRoomGroups(),

  // ── Rooms ────────────────────────────────────────────────────────

  setRooms: (rooms) => set({ rooms }),

  addRoom: (room) => set((s) => {
    if (s.rooms.some((r) => r.id === room.id)) return s;
    return { rooms: [...s.rooms, room] };
  }),

  updateRoom: (roomId, updates) =>
    set((s) => ({
      rooms: s.rooms.map((r) =>
        r.id === roomId ? { ...r, ...updates, updatedAt: updates.updatedAt ?? new Date().toISOString() } : r
      ),
    })),

  removeRoom: (roomId) =>
    set((s) => ({ rooms: s.rooms.filter((r) => r.id !== roomId) })),

  setActiveRoomId: (roomId) => set({ activeRoomId: roomId }),

  // ── Messages ─────────────────────────────────────────────────────

  setMessages: (roomId, messages) =>
    set((s) => ({
      messagesByRoom: { ...s.messagesByRoom, [roomId]: messages },
    })),

  addMessage: (roomId, message) =>
    set((s) => {
      const existing = s.messagesByRoom[roomId] ?? [];
      // Dedup by id
      if (existing.some((m) => m.id === message.id)) return s;
      return {
        messagesByRoom: { ...s.messagesByRoom, [roomId]: [...existing, message] },
      };
    }),

  prependMessages: (roomId, messages) =>
    set((s) => {
      const existing = s.messagesByRoom[roomId] ?? [];
      const existingIds = new Set(existing.map((m) => m.id));
      const newOnly = messages.filter((m) => !existingIds.has(m.id));
      if (newOnly.length === 0) return s;
      return {
        messagesByRoom: { ...s.messagesByRoom, [roomId]: [...newOnly, ...existing] },
      };
    }),

  patchMessageShortIds: (roomId, updates) =>
    set((s) => {
      const existing = s.messagesByRoom[roomId];
      if (!existing || updates.length === 0) return s;
      const map = new Map(updates.map((u) => [u.id, u.shortId]));
      let changed = false;
      const next = existing.map((m) => {
        if (m.shortId) return m;
        const sid = map.get(m.id);
        if (!sid) return m;
        changed = true;
        return { ...m, shortId: sid };
      });
      return changed ? { messagesByRoom: { ...s.messagesByRoom, [roomId]: next } } : s;
    }),

  updateMessage: (roomId, messageId, updates) =>
    set((s) => {
      const existing = s.messagesByRoom[roomId];
      if (!existing) return s;
      const matchIds = new Set([messageId]);
      if (typeof updates.id === 'string') matchIds.add(updates.id);
      return {
        messagesByRoom: {
          ...s.messagesByRoom,
          [roomId]: existing.map((m) => (matchIds.has(m.id) ? { ...m, ...updates } : m)),
        },
      };
    }),

  removeMessage: (roomId, messageId) =>
    set((s) => {
      const existing = s.messagesByRoom[roomId];
      if (!existing) return s;
      return {
        messagesByRoom: {
          ...s.messagesByRoom,
          [roomId]: existing.filter((m) => m.id !== messageId),
        },
      };
    }),

  confirmPendingMessage: (roomId, clientMsgId, serverMessage) =>
    set((s) => {
      const existing = s.messagesByRoom[roomId];
      if (!existing) return s;
      const idx = existing.findIndex((m) => m.clientMsgId === clientMsgId && m.pending);
      if (idx === -1) return s;
      const updated = [...existing];
      updated[idx] = { ...serverMessage, pending: false, failed: false };
      return {
        messagesByRoom: { ...s.messagesByRoom, [roomId]: updated },
      };
    }),

  markMessageFailed: (roomId, clientMsgId) =>
    set((s) => {
      const existing = s.messagesByRoom[roomId];
      if (!existing) return s;
      return {
        messagesByRoom: {
          ...s.messagesByRoom,
          [roomId]: existing.map((m) =>
            m.clientMsgId === clientMsgId && m.pending
              ? { ...m, pending: false, failed: true }
              : m
          ),
        },
      };
    }),

  // ── Members ──────────────────────────────────────────────────────

  setMembers: (roomId, members) =>
    set((s) => ({
      membersByRoom: { ...s.membersByRoom, [roomId]: members },
    })),

  addMember: (roomId, member) =>
    set((s) => {
      const existing = s.membersByRoom[roomId] ?? [];
      if (existing.some((m) => m.userId === member.userId)) return s;
      return {
        membersByRoom: { ...s.membersByRoom, [roomId]: [...existing, member] },
      };
    }),

  removeMember: (roomId, userId) =>
    set((s) => {
      const existing = s.membersByRoom[roomId];
      if (!existing) return s;
      return {
        membersByRoom: {
          ...s.membersByRoom,
          [roomId]: existing.filter((m) => m.userId !== userId),
        },
      };
    }),

  // ── Unread ───────────────────────────────────────────────────────

  setUnreadCounts: (counts) => set({ unreadCounts: counts }),

  incrementUnread: (roomId) =>
    set((s) => ({
      unreadCounts: { ...s.unreadCounts, [roomId]: (s.unreadCounts[roomId] ?? 0) + 1 },
    })),

  clearUnread: (roomId) =>
    set((s) => {
      if (!s.unreadCounts[roomId]) return s;
      return { unreadCounts: { ...s.unreadCounts, [roomId]: 0 } };
    }),

  // ── Typing ───────────────────────────────────────────────────────

  setTyping: (roomId, user) => {
    const key = typingKey(roomId, user.userId);

    // Clear any existing timeout for this user in this room
    const prev = typingTimeouts.get(key);
    if (prev) clearTimeout(prev);

    // Auto-clear after 5 seconds
    const timeout = setTimeout(() => {
      typingTimeouts.delete(key);
      get().clearTyping(roomId, user.userId);
    }, 5000);
    typingTimeouts.set(key, timeout);

    set((s) => {
      const existing = s.typingByRoom[roomId] ?? [];
      const filtered = existing.filter((t) => t.userId !== user.userId);
      return {
        typingByRoom: { ...s.typingByRoom, [roomId]: [...filtered, user] },
      };
    });
  },

  clearTyping: (roomId, userId) => {
    const key = typingKey(roomId, userId);
    const prev = typingTimeouts.get(key);
    if (prev) {
      clearTimeout(prev);
      typingTimeouts.delete(key);
    }

    set((s) => {
      const existing = s.typingByRoom[roomId];
      if (!existing) return s;
      const filtered = existing.filter((t) => t.userId !== userId);
      return {
        typingByRoom: { ...s.typingByRoom, [roomId]: filtered },
      };
    });
  },

  // ── Notifications ────────────────────────────────────────────────

  setNotifications: (notifications) => set({ notifications }),

  addNotification: (notification) =>
    set((s) => {
      if (s.notifications.some((n) => n.id === notification.id)) return s;
      return {
        notifications: [notification, ...s.notifications],
        unreadNotifCount: s.unreadNotifCount + 1,
      };
    }),

  markNotificationRead: (notifId) =>
    set((s) => {
      const target = s.notifications.find((n) => n.id === notifId);
      if (!target || target.read) return s;
      return {
        notifications: s.notifications.map((n) =>
          n.id === notifId ? { ...n, read: true } : n
        ),
        unreadNotifCount: Math.max(0, s.unreadNotifCount - 1),
      };
    }),

  markAllNotificationsRead: () =>
    set((s) => ({
      notifications: s.notifications.map((n) => ({ ...n, read: true })),
      unreadNotifCount: 0,
    })),

  setUnreadNotifCount: (count) => set({ unreadNotifCount: count }),

  // ── Loading ──────────────────────────────────────────────────────

  setLoading: (loading) => set({ loading }),
  setMessagesLoading: (messagesLoading) => set({ messagesLoading }),

  // ── PG ───────────────────────────────────────────────────────────

  setPgEnabled: (pgEnabled) => set({ pgEnabled }),

  // ── Room group collapse ────────────────────────────────────────

  toggleRoomGroupCollapsed: (groupId) =>
    set((s) => {
      const next = new Set(s.collapsedRoomGroups);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      saveCollapsedRoomGroups(next);
      return { collapsedRoomGroups: next };
    }),
}));
