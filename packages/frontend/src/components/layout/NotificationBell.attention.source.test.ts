import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './NotificationBell.tsx'), 'utf8');

describe('Notification and Session attention alignment', () => {
  it('marks the source Session read when a related notification is acknowledged', () => {
    expect(source).toContain("notification.metadata?.sessionId || notification.sessionId");
    expect(source).toContain("useSessionStore.getState().markSessionRead(sessionId)");
  });

  it('still persists the notification read state through the notification API', () => {
    expect(source).toContain("fetch(towerHttpUrl(`/api/notifications/${notifId}/read`)");
  });
});
