import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const sourceRoot = path.resolve(import.meta.dirname, '../..');

function source(relativePath: string): string {
  return fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8');
}

describe('notification surface contracts', () => {
  it('mounts a single app-level Toaster', () => {
    const files = [
      'App.tsx',
      'components/files/FileViewerPage.tsx',
    ];
    const count = files.reduce((sum, file) => sum + (source(file).match(/<Toaster\b/g) || []).length, 0);
    expect(count).toBe(1);
    expect(source('components/files/FileViewerPage.tsx')).not.toContain("from 'sonner'");
  });

  it('keeps restart and active-context notification feedback on one primary surface', () => {
    const runtime = source('hooks/useChatRuntime.ts');
    expect(runtime).not.toContain("toastWarning('Server restarted')");
    expect(runtime).toContain('UpdateBanner is the single user-facing surface');
    expect(runtime).toContain("sessionState.activeView === 'chat'");
    expect(runtime).toContain('sessionState.activeSessionId === notificationSessionId');
    expect(runtime).toContain('if (isViewingNotificationSession) break;');
    expect(runtime).not.toContain('isViewingNotificationRoom');
  });
});

it('groups settings around current features without advertising retired task products', () => {
  const settings = readFileSync(new URL('./NotificationSettingsPanel.tsx', import.meta.url), 'utf8');
  expect(settings).toContain("events: ['automation.completed', 'automation.failed']");
  expect(settings).toContain("events: ['session.completed', 'spawn.completed', 'proactive.message', 'task.completed', 'task.failed']");
  expect(settings).not.toContain('groupLongTaskDoneTitle');
  expect(settings).not.toContain('projectNotificationHint');
  expect(settings).toContain('notificationDeliveryHint');
});

it('uses in-app session selection for notification toast actions', () => {
  const runtime = readFileSync(new URL('../../hooks/useChatRuntime.ts', import.meta.url), 'utf8');
  expect(runtime).not.toContain('window.location.assign(`/s/${encodeURIComponent(notificationSessionId)}`)');
  expect(runtime).toContain("detail: { sessionId: notificationSessionId }");
  const navigation = readFileSync(new URL('../../hooks/useSessionEventNavigation.ts', import.meta.url), 'utf8');
  expect(navigation).toContain("'tower-open-session'");
  expect(navigation).toContain("removeEventListener('message', handlePushNavigation)");
});

it('requests iOS push permission before network IO and keeps session completion enabled', () => {
  const push = readFileSync(new URL('../../lib/push-notifications.ts', import.meta.url), 'utf8');
  const subscribe = push.slice(push.indexOf('export async function subscribeToWebPush'));
  expect(subscribe.indexOf('Notification.requestPermission()')).toBeLessThan(subscribe.indexOf('await getVapidInfo()'));
  const settings = readFileSync(new URL('./NotificationSettingsPanel.tsx', import.meta.url), 'utf8');
  expect(settings).not.toContain("recommendedPushEvents");
  expect(settings).toContain('iosPushHint');
});


it('exposes only session results and scheduled work on desktop and mobile', () => {
  const settings = source('components/notifications/NotificationSettingsPanel.tsx');
  const groups = settings.slice(settings.indexOf('const groups:'), settings.indexOf('const globalChannels'));
  expect(groups.match(/id: '/g)).toHaveLength(2);
  for (const retired of ['message.mention', 'message.room', 'system.announcement', 'groupDirect', 'groupMessages', 'groupAnnouncements']) {
    expect(groups).not.toContain(retired);
  }
  expect(settings).not.toContain('recommendedPushEvents'); // Preserve event choices when reconnecting.
});

it('preserves settings until save succeeds and exposes per-device registration', () => {
  const settings = source('components/notifications/NotificationSettingsPanel.tsx');
  expect(settings).toContain('if (saveLock.current) return false');
  expect(settings).not.toContain('setPrefs(next)');
  expect(settings).toContain('hasLocalPushSubscription');
  expect(settings).toContain('pushConnectDevice');
  expect(settings).toContain('aria-label={label}');
  expect(settings).toContain('aria-checked={checked}');
});

it('does not claim successful test delivery when no requests were accepted', () => {
  const settings = source('components/notifications/NotificationSettingsPanel.tsx');
  expect(settings).toContain('result.sent === 0 || result.failed > 0');
  expect(settings).toContain("t('testNotificationIncomplete'");
  expect(settings).toContain('if (pushBusy || saveLock.current) return');
});
