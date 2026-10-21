import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

// Inspect the server policy without adding a frontend-to-backend module dependency.
const preferencesSource = readFileSync(new URL('../../../../backend/services/notifications/notification-types.ts', import.meta.url), 'utf8');
const preferencesExports = {} as { DEFAULT_NOTIFICATION_EVENTS: Array<{ eventType: string; inApp: boolean; toast: boolean; webPush: boolean }> };
runInNewContext(ts.transpileModule(preferencesSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: preferencesExports });
const { DEFAULT_NOTIFICATION_EVENTS } = preferencesExports;

const script = readFileSync(new URL('../../../public/push-handlers.js', import.meta.url), 'utf8');
async function deliver(windows: object[], type = 'session.completed') {
  const handlers: Record<string, (event: any) => void> = {};
  const showNotification = vi.fn();
  runInNewContext(script, {
    URL,
    self: {
      location: { origin: 'https://tower.example.com' },
      addEventListener: (name: string, handler: any) => { handlers[name] = handler; },
      registration: { showNotification },
      clients: { matchAll: async () => windows },
    },
  });
  let pending: Promise<void> | undefined;
  handlers.push({
    data: { json: () => ({ type, actionUrl: '/s/abcdefgh', title: 'Done' }) },
    waitUntil: (promise: Promise<void>) => { pending = promise; },
  });
  await pending;
  return showNotification;
}
const current = { url: 'https://tower.example.com/s/abcdefgh', focused: true, visibilityState: 'visible' };
describe('session completion push', () => {
  it('enables default session push without changing other event defaults', () => {
    expect(DEFAULT_NOTIFICATION_EVENTS.find(e => e.eventType === 'session.completed')).toMatchObject({
      inApp: true, toast: true, webPush: true,
    });
  });
  it('suppresses a visibly focused target session', async () => {
    expect(await deliver([current])).not.toHaveBeenCalled();
  });
  it.each([
    [],
    [{ ...current, focused: false }],
    [{ ...current, visibilityState: 'hidden' }],
    [{ ...current, url: 'https://tower.example.com/s/otherkey' }],
    [{ ...current, url: `${current.url}?view=inbox` }],
    [{ ...current, url: `${current.url}?system=publishing` }],
  ])('shows push when target is not being viewed: %j', async (...windows) => {
    expect(await deliver(windows)).toHaveBeenCalledOnce();
  });
  it('does not suppress other event types', async () => {
    expect(await deliver([current], 'task.failed')).toHaveBeenCalledOnce();
  });
});
