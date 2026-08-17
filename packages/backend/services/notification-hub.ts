/**
 * Notification Hub — Central place for creating notifications + pushing via WS.
 *
 * Connects the existing room-manager notification CRUD with WS broadcast.
 * All notification creation should flow through this module.
 */

import { createNotification, createNotificationsBatch } from './room/room-manager.js';
import { isPgEnabled } from '../db/pg.js';
import { resolveNotificationPolicy } from './notifications/notification-preferences.js';
import { sendWebPushToUser } from './notifications/web-push-sender.js';
import type { NotificationChannel, NotificationPriority } from './notifications/notification-types.js';

export type BroadcastFn = (type: string, data: any) => void;

export interface NotifyOptions {
  projectId?: string | null;
  sessionId?: string | null;
  priority?: NotificationPriority;
  actionUrl?: string | null;
  defaultChannels?: NotificationChannel[];
}

export interface ExecutionReportInput {
  userId: number;
  kind: 'task' | 'automation';
  sourceId: string;
  name: string;
  status: 'completed' | 'failed';
  body?: string;
  projectId?: string | null;
  sessionId?: string | null;
  actionUrl?: string | null;
  metadata?: Record<string, unknown>;
}

let broadcastFn: BroadcastFn | null = null;

/**
 * Initialize the hub with a broadcast function from ws-handler.
 */
export function initNotificationHub(broadcast: BroadcastFn): void {
  broadcastFn = broadcast;
}

/**
 * Create a notification and push it to the user via WebSocket in real-time.
 */
export async function notify(
  userId: number,
  roomId: string | null,
  type: string,
  title: string,
  body?: string,
  metadata?: Record<string, unknown>,
  options: NotifyOptions = {},
): Promise<string> {
  const policy = isPgEnabled()
    ? await resolveNotificationPolicy(userId, {
      type,
      projectId: options.projectId ?? (metadata?.projectId as string | undefined) ?? null,
      priority: options.priority ?? 'normal',
      defaultChannels: options.defaultChannels,
    })
    : { channels: ['in_app' as NotificationChannel, 'toast' as NotificationChannel], normalizedType: type, shouldCreateInApp: true };

  if (policy.channels.length === 0) return '';

  // 1. Persist to DB (only if PG is available)
  let notifId: string;
  if (isPgEnabled()) {
    notifId = await createNotification(userId, roomId, policy.normalizedType, title, body, metadata, {
      projectId: options.projectId ?? (metadata?.projectId as string | undefined) ?? null,
      sessionId: options.sessionId ?? (metadata?.sessionId as string | undefined) ?? null,
      priority: options.priority ?? 'normal',
      actionUrl: options.actionUrl ?? (metadata?.actionUrl as string | undefined) ?? null,
      channels: policy.channels,
    });
  } else {
    notifId = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // 2. Push via WS (real-time). Web Push is intentionally Phase 2.
  const notification = {
    id: notifId,
    userId,
    roomId,
    projectId: options.projectId ?? (metadata?.projectId as string | undefined) ?? null,
    sessionId: options.sessionId ?? (metadata?.sessionId as string | undefined) ?? null,
    type: policy.normalizedType,
    title,
    body: body ?? null,
    metadata: metadata ?? {},
    priority: options.priority ?? 'normal',
    actionUrl: options.actionUrl ?? (metadata?.actionUrl as string | undefined) ?? null,
    channels: policy.channels,
    deliveredChannels: {},
    read: false,
    createdAt: new Date().toISOString(),
  };

  if (policy.channels.includes('in_app') || policy.channels.includes('toast')) {
    broadcastFn?.('notification', { targetUserId: userId, notification, channels: policy.channels });
  }

  if (policy.channels.includes('web_push')) {
    sendWebPushToUser(userId, {
      notificationId: notifId,
      title,
      body: body ?? null,
      actionUrl: notification.actionUrl || '/',
      tag: `${policy.normalizedType}:${options.sessionId ?? options.projectId ?? roomId ?? notifId}`,
      type: policy.normalizedType,
    }).catch((err) => console.warn(`[notification-hub] web_push failed: ${err?.message || err}`));
  }

  return notifId;
}

/**
 * Notify a batch of users with the same title/body but distinct user IDs.
 * Does a single INSERT round-trip (batch) and then fans out WS messages.
 *
 * Added 2026-04-10: previously `notifyRoomMembers` did N sequential awaits.
 */
/**
 * Persist and route one Task/Automation terminal report through Notification.
 * Detailed output remains in the Task/Automation run and execution Session.
 */
export async function notifyExecutionReport(input: ExecutionReportInput): Promise<string> {
  const failed = input.status === 'failed';
  const type = `${input.kind}.${input.status}`;
  const title = failed ? `${input.name} 실패` : `${input.name} 완료`;
  const body = input.body && input.body.length > 280
    ? `${input.body.slice(0, 280)}…`
    : input.body;

  return notify(
    input.userId,
    null,
    type,
    title,
    body,
    {
      source: { kind: input.kind, id: input.sourceId },
      sourceId: input.sourceId,
      status: input.status,
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      actionUrl: input.actionUrl ?? null,
      ...input.metadata,
    },
    {
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      priority: failed ? 'high' : 'normal',
      actionUrl: input.actionUrl ?? null,
    },
  );
}

export async function notifyMany(
  userIds: number[],
  roomId: string | null,
  type: string,
  title: string,
  body?: string,
  metadata?: Record<string, unknown>,
  options: NotifyOptions = {},
): Promise<string[]> {
  if (userIds.length === 0) return [];

  const allowed: Array<{ userId: number; channels: NotificationChannel[]; normalizedType: string }> = [];
  if (isPgEnabled()) {
    for (const userId of userIds) {
      const policy = await resolveNotificationPolicy(userId, {
        type,
        projectId: options.projectId ?? (metadata?.projectId as string | undefined) ?? null,
        priority: options.priority ?? 'normal',
        defaultChannels: options.defaultChannels,
      });
      if (policy.channels.length > 0) {
        allowed.push({ userId, channels: policy.channels, normalizedType: policy.normalizedType });
      }
    }
  } else {
    allowed.push(...userIds.map(userId => ({ userId, channels: ['in_app' as NotificationChannel, 'toast' as NotificationChannel], normalizedType: type })));
  }

  if (allowed.length === 0) return [];

  let ids: Array<{ userId: number; notifId: string }>;
  if (isPgEnabled()) {
    ids = await createNotificationsBatch(
      allowed.map(({ userId, channels, normalizedType }) => ({
        userId,
        roomId,
        type: normalizedType,
        title,
        body,
        metadata,
        options: {
          projectId: options.projectId ?? (metadata?.projectId as string | undefined) ?? null,
          sessionId: options.sessionId ?? (metadata?.sessionId as string | undefined) ?? null,
          priority: options.priority ?? 'normal',
          actionUrl: options.actionUrl ?? (metadata?.actionUrl as string | undefined) ?? null,
          channels,
        },
      })),
    );
  } else {
    ids = allowed.map(({ userId }) => ({
      userId,
      notifId: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }));
  }

  const createdAt = new Date().toISOString();
  for (const { userId, notifId } of ids) {
    const policy = allowed.find((item) => item.userId === userId);
    if (!policy) continue;
    const notification = {
      id: notifId,
      userId,
      roomId,
      projectId: options.projectId ?? (metadata?.projectId as string | undefined) ?? null,
      sessionId: options.sessionId ?? (metadata?.sessionId as string | undefined) ?? null,
      type: policy.normalizedType,
      title,
      body: body ?? null,
      metadata: metadata ?? {},
      priority: options.priority ?? 'normal',
      actionUrl: options.actionUrl ?? (metadata?.actionUrl as string | undefined) ?? null,
      channels: policy.channels,
      deliveredChannels: {},
      read: false,
      createdAt,
    };

    if (policy.channels.includes('in_app') || policy.channels.includes('toast')) {
      broadcastFn?.('notification', {
        targetUserId: userId,
        channels: policy.channels,
        notification,
      });
    }

    if (policy.channels.includes('web_push')) {
      sendWebPushToUser(userId, {
        notificationId: notifId,
        title,
        body: body ?? null,
        actionUrl: notification.actionUrl || '/',
        tag: `${policy.normalizedType}:${options.sessionId ?? options.projectId ?? roomId ?? notifId}`,
        type: policy.normalizedType,
      }).catch((err) => console.warn(`[notification-hub] web_push failed: ${err?.message || err}`));
    }
  }

  return ids.map(x => x.notifId);
}

/**
 * Notify all members of a room.
 * Optionally exclude a user (e.g. the sender).
 */
export async function notifyRoomMembers(
  roomId: string,
  type: string,
  title: string,
  body?: string,
  metadata?: Record<string, unknown>,
  excludeUserId?: number,
): Promise<void> {
  const { getMembers } = await import('./room/room-manager.js');
  const members = await getMembers(roomId);

  const targets = members
    .filter(m => m.userId !== excludeUserId)
    .map(m => m.userId);

  await notifyMany(targets, roomId, type, title, body, metadata);
}
