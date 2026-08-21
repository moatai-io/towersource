import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const header = fs.readFileSync(path.resolve(import.meta.dirname, './Header.tsx'), 'utf8');
const mobile = fs.readFileSync(path.resolve(import.meta.dirname, './MobileTabBar.tsx'), 'utf8');
const inbox = fs.readFileSync(path.resolve(import.meta.dirname, '../inbox/InboxPanel.tsx'), 'utf8');

describe('Work navigation attention badge', () => {
  it('derives desktop and mobile badges from the same unread Session projection', () => {
    expect(header).toContain('const workAttentionCount = useSessionStore((s) => s.unreadSessions.size)');
    expect(header).toContain("{ key: 'work', label: t('workHubNav'), badge: workAttentionCount }");
    expect(mobile).toContain('const workAttentionCount = useSessionStore((s) => s.unreadSessions.size)');
    expect(mobile).toContain("{ id: 'work', label: t('workHubNav'), icon: tabIcons.work, badge: workAttentionCount }");
  });

  it('keeps the badge visible on the active mobile Work tab until individual results are reviewed', () => {
    expect(mobile).toContain('tab.badge != null && tab.badge > 0');
    expect(mobile).not.toContain("tab.badge > 0 && mobileTab !== tab.id");
  });

  it('clears the underlying unread projection only when a result opens its source Session', () => {
    expect(inbox).toContain('onClick={() => openSession(session)}');
    expect(inbox).toContain('markSessionRead(session.id)');
  });
});
