/**
 * Owns: best-effort browser/PWA Web Push delivery.
 * Public API: sendWebPushToUser, isWebPushConfigured, getWebPushPublicKey.
 */

import webpush from 'web-push';
import { config } from '../../config.js';
import { listPushSubscriptions, disablePushSubscriptionGlobal } from './push-subscriptions.js';

let configured = false;

function configureOnce(): boolean {
  if (configured) return true;
  if (!config.webPush.publicKey || !config.webPush.privateKey) return false;
  webpush.setVapidDetails(
    config.webPush.subject,
    config.webPush.publicKey,
    config.webPush.privateKey,
  );
  configured = true;
  return true;
}

export function isWebPushConfigured(): boolean {
  return !!config.webPush.publicKey && !!config.webPush.privateKey;
}

export function getWebPushPublicKey(): string {
  return config.webPush.publicKey;
}

export interface WebPushPayload {
  notificationId: string;
  title: string;
  body?: string | null;
  actionUrl?: string | null;
  tag?: string;
  type?: string;
  renotify?: boolean;
  requireInteraction?: boolean;
}

function compactText(text: string | null | undefined, max = 120): string | null {
  if (!text) return null;
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function formatPayload(payload: WebPushPayload): WebPushPayload {
  const type = payload.type || 'system.announcement';
  const body = compactText(payload.body, type === 'message.mention' ? 96 : 120);
  const base = { ...payload, body, type };

  if (type === 'message.mention' || type === 'mention') {
    return {
      ...base,
      title: payload.title.startsWith('@') ? payload.title : `@멘션 · ${payload.title}`,
      tag: payload.tag || `mention:${payload.notificationId}`,
      renotify: true,
    };
  }

  if (type === 'session.completed' || type === 'spawn.completed' || type === 'proactive.message') {
    return {
      ...base,
      title: payload.title || 'AI 작업이 끝났습니다',
      tag: payload.tag || `ai:${payload.notificationId}`,
    };
  }

  if (type === 'task.failed' || type === 'automation.failed') {
    return {
      ...base,
      title: payload.title || '확인이 필요합니다',
      tag: payload.tag || `action:${payload.notificationId}`,
      renotify: true,
      requireInteraction: true,
    };
  }

  return {
    ...base,
    title: payload.title || 'Tower 알림',
    tag: payload.tag || `${type}:${payload.notificationId}`,
  };
}

export async function sendWebPushToUser(userId: number, payload: WebPushPayload): Promise<{ sent: number; failed: number }> {
  const formatted = formatPayload(payload);
  if (!configureOnce()) return { sent: 0, failed: 0 };

  const subs = await listPushSubscriptions(userId, true);
  let sent = 0;
  let failed = 0;

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        JSON.stringify(formatted),
        { TTL: 60, urgency: formatted.renotify ? 'high' : 'normal' },
      );
      sent += 1;
    } catch (err: any) {
      failed += 1;
      const status = err?.statusCode;
      if (status === 404 || status === 410) {
        await disablePushSubscriptionGlobal(sub.id);
      } else {
        console.warn(`[web-push] send failed user=${userId} sub=${sub.id}: ${err?.message || err}`);
      }
    }
  }

  return { sent, failed };
}
