/**
 * Owns: User/event/project notification preference resolution.
 * Public API: getNotificationPreferences, updateNotificationPreferences,
 * resolveNotificationPolicy.
 * See: workspace/decisions/2026-06-05-notification-center-browser-pwa-plan.md.
 */

import { getPgPool } from '../../db/pg.js';
import {
  DEFAULT_NOTIFICATION_EVENTS,
  PRIORITY_RANK,
  normalizeNotificationType,
  type NotificationChannel,
  type NotificationPriority,
} from './notification-types.js';

export interface NotificationPreferenceInput {
  type: string;
  projectId?: string | null;
  priority?: NotificationPriority;
  defaultChannels?: NotificationChannel[];
}

export interface NotificationPolicy {
  channels: NotificationChannel[];
  normalizedType: string;
  shouldCreateInApp: boolean;
  reason?: string;
}

const DEFAULT_GLOBAL = {
  inAppEnabled: true,
  toastEnabled: true,
  // Browser/PWA notifications are explicit opt-in: the user must enable this
  // in settings and grant the browser permission before web_push can route.
  webPushEnabled: false,
  quietHoursEnabled: false,
  quietHoursStart: null as string | null,
  quietHoursEnd: null as string | null,
  timezone: 'Asia/Seoul',
};

function boolOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function toDbBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function uniqueChannels(channels: NotificationChannel[]): NotificationChannel[] {
  return Array.from(new Set(channels));
}

function defaultEventMap() {
  return Object.fromEntries(DEFAULT_NOTIFICATION_EVENTS.map((event) => [event.eventType, event]));
}

export async function getNotificationPreferences(userId: number, role = 'member') {
  const pool = getPgPool();

  const [globalRes, eventRes, projectRes] = await Promise.all([
    pool.query('SELECT * FROM user_notification_preferences WHERE user_id = $1', [userId]),
    pool.query('SELECT * FROM user_notification_event_preferences WHERE user_id = $1', [userId]),
    pool.query(
      `SELECT p.id AS project_id, p.name AS project_name, pn.enabled, pn.in_app, pn.toast, pn.web_push, pn.muted_until
       FROM projects p
       LEFT JOIN user_notification_project_preferences pn
         ON pn.project_id = p.id AND pn.user_id = $1
       WHERE p.archived = 0
         AND (
           $2::text IN ('admin', 'operator')
           OR p.user_id = $1
           OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $1)
         )
       ORDER BY p.sort_order ASC, p.name ASC`,
      [userId, role],
    ),
  ]);

  const globalRow = globalRes.rows[0];
  const global = globalRow ? {
    inAppEnabled: !!globalRow.in_app_enabled,
    toastEnabled: !!globalRow.toast_enabled,
    webPushEnabled: !!globalRow.web_push_enabled,
    quietHoursEnabled: !!globalRow.quiet_hours_enabled,
    quietHoursStart: globalRow.quiet_hours_start ?? null,
    quietHoursEnd: globalRow.quiet_hours_end ?? null,
    timezone: globalRow.timezone ?? 'Asia/Seoul',
  } : DEFAULT_GLOBAL;

  const events = defaultEventMap();
  for (const row of eventRes.rows) {
    events[row.event_type] = {
      ...(events[row.event_type] ?? {
        eventType: row.event_type,
        label: row.event_type,
        description: '',
      }),
      eventType: row.event_type,
      inApp: !!row.in_app,
      toast: !!row.toast,
      webPush: !!row.web_push,
      minPriority: row.min_priority ?? 'normal',
    };
  }

  const projects = projectRes.rows.map((row: any) => ({
    projectId: row.project_id,
    projectName: row.project_name,
    enabled: row.enabled === null || row.enabled === undefined ? true : !!row.enabled,
    inApp: row.in_app === null || row.in_app === undefined ? null : !!row.in_app,
    toast: row.toast === null || row.toast === undefined ? null : !!row.toast,
    webPush: row.web_push === null || row.web_push === undefined ? null : !!row.web_push,
    mutedUntil: row.muted_until ? (row.muted_until instanceof Date ? row.muted_until.toISOString() : String(row.muted_until)) : null,
  }));

  return {
    global,
    events: Object.values(events),
    projects,
  };
}

export async function updateNotificationPreferences(userId: number, body: any, role = 'member') {
  const pool = getPgPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (body.global && typeof body.global === 'object') {
      const g = body.global;
      await client.query(
        `INSERT INTO user_notification_preferences
           (user_id, in_app_enabled, toast_enabled, web_push_enabled, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, timezone, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           in_app_enabled = EXCLUDED.in_app_enabled,
           toast_enabled = EXCLUDED.toast_enabled,
           web_push_enabled = EXCLUDED.web_push_enabled,
           quiet_hours_enabled = EXCLUDED.quiet_hours_enabled,
           quiet_hours_start = EXCLUDED.quiet_hours_start,
           quiet_hours_end = EXCLUDED.quiet_hours_end,
           timezone = EXCLUDED.timezone,
           updated_at = NOW()`,
        [
          userId,
          boolOrDefault(g.inAppEnabled, DEFAULT_GLOBAL.inAppEnabled),
          boolOrDefault(g.toastEnabled, DEFAULT_GLOBAL.toastEnabled),
          boolOrDefault(g.webPushEnabled, DEFAULT_GLOBAL.webPushEnabled),
          boolOrDefault(g.quietHoursEnabled, DEFAULT_GLOBAL.quietHoursEnabled),
          typeof g.quietHoursStart === 'string' ? g.quietHoursStart : null,
          typeof g.quietHoursEnd === 'string' ? g.quietHoursEnd : null,
          typeof g.timezone === 'string' ? g.timezone : DEFAULT_GLOBAL.timezone,
        ],
      );
    }

    if (Array.isArray(body.events)) {
      for (const e of body.events) {
        if (!e?.eventType || typeof e.eventType !== 'string') continue;
        await client.query(
          `INSERT INTO user_notification_event_preferences
             (user_id, event_type, in_app, toast, web_push, min_priority, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (user_id, event_type) DO UPDATE SET
             in_app = EXCLUDED.in_app,
             toast = EXCLUDED.toast,
             web_push = EXCLUDED.web_push,
             min_priority = EXCLUDED.min_priority,
             updated_at = NOW()`,
          [
            userId,
            normalizeNotificationType(e.eventType),
            boolOrDefault(e.inApp, true),
            boolOrDefault(e.toast, true),
            boolOrDefault(e.webPush, false),
            typeof e.minPriority === 'string' ? e.minPriority : 'normal',
          ],
        );
      }
    }

    if (Array.isArray(body.projects)) {
      for (const p of body.projects) {
        if (!p?.projectId || typeof p.projectId !== 'string') continue;
        await client.query(
          `INSERT INTO user_notification_project_preferences
             (user_id, project_id, enabled, in_app, toast, web_push, muted_until, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (user_id, project_id) DO UPDATE SET
             enabled = EXCLUDED.enabled,
             in_app = EXCLUDED.in_app,
             toast = EXCLUDED.toast,
             web_push = EXCLUDED.web_push,
             muted_until = EXCLUDED.muted_until,
             updated_at = NOW()`,
          [
            userId,
            p.projectId,
            boolOrDefault(p.enabled, true),
            toDbBool(p.inApp),
            toDbBool(p.toast),
            toDbBool(p.webPush),
            p.mutedUntil ? new Date(p.mutedUntil) : null,
          ],
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return getNotificationPreferences(userId, role);
}

export async function resolveNotificationPolicy(
  userId: number,
  input: NotificationPreferenceInput,
): Promise<NotificationPolicy> {
  const normalizedType = normalizeNotificationType(input.type);
  const priority = input.priority ?? 'normal';
  const preferences = await getNotificationPreferences(userId);
  const event = preferences.events.find((e: any) => e.eventType === normalizedType)
    ?? DEFAULT_NOTIFICATION_EVENTS.find((e) => e.eventType === normalizedType);

  if (event) {
    const minPriority = event.minPriority as NotificationPriority;
    if ((PRIORITY_RANK[priority] ?? 1) < (PRIORITY_RANK[minPriority] ?? 1)) {
      return { channels: [], normalizedType, shouldCreateInApp: false, reason: 'below_min_priority' };
    }
  }

  let channels: NotificationChannel[] = input.defaultChannels?.length
    ? [...input.defaultChannels]
    : [
      ...(event?.inApp !== false ? ['in_app' as const] : []),
      ...(event?.toast === true ? ['toast' as const] : []),
      ...(event?.webPush === true ? ['web_push' as const] : []),
    ];

  if (!preferences.global.inAppEnabled) channels = channels.filter((ch) => ch !== 'in_app');
  if (!preferences.global.toastEnabled) channels = channels.filter((ch) => ch !== 'toast');
  if (!preferences.global.webPushEnabled) channels = channels.filter((ch) => ch !== 'web_push');

  if (input.projectId) {
    const projectPref = preferences.projects.find((p: any) => p.projectId === input.projectId);
    const mutedUntil = projectPref?.mutedUntil ? new Date(projectPref.mutedUntil).getTime() : 0;
    if (projectPref && (!projectPref.enabled || mutedUntil > Date.now())) {
      return { channels: [], normalizedType, shouldCreateInApp: false, reason: 'project_muted' };
    }
    if (projectPref?.inApp === false) channels = channels.filter((ch) => ch !== 'in_app');
    if (projectPref?.toast === false) channels = channels.filter((ch) => ch !== 'toast');
    if (projectPref?.webPush === false) channels = channels.filter((ch) => ch !== 'web_push');
    if (projectPref?.inApp === true && preferences.global.inAppEnabled) channels.push('in_app');
    if (projectPref?.toast === true && preferences.global.toastEnabled) channels.push('toast');
    if (projectPref?.webPush === true && preferences.global.webPushEnabled) channels.push('web_push');
  }

  channels = uniqueChannels(channels);
  return { channels, normalizedType, shouldCreateInApp: channels.includes('in_app') };
}
