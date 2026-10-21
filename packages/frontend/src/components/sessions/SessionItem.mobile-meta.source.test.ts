import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './SessionItem.tsx'), 'utf8');
const css = fs.readFileSync(path.resolve(import.meta.dirname, '../../index.css'), 'utf8');
const sidebar = fs.readFileSync(path.resolve(import.meta.dirname, '../layout/Sidebar.tsx'), 'utf8');
const timeline = fs.readFileSync(path.resolve(import.meta.dirname, '../../features/navigation-sidebar/sessions/SidebarSessionTimeline.tsx'), 'utf8');

describe('mobile Session row metadata', () => {
  it('shows the owner user id and relative activity time on mobile', () => {
    expect(source).toContain(') : isMobile ? (');
    expect(source).toContain('{ownerLabel}');
    expect(source).toContain('`${ownerUsername} · ${relativeTime(session.updatedAt)}`');
    expect(source).toContain('{relativeTime(session.updatedAt)}');
    expect(source).not.toContain('compactSessionId');
    expect(source).toContain('sidebar-session-meta--mobile-visible');
  });

  it('does not let the narrow-sidebar rule hide mobile metadata', () => {
    expect(css).toContain('.sidebar-session-meta--compact-responsive:not(.sidebar-session-meta--mobile-visible)');
  });

  it('uses the same SessionItem for selected-agent and Latest lists', () => {
    expect(sidebar).toContain('latestVisibleSessions.map((session) => (');
    expect(sidebar).toContain('compactMetaAtNarrowWidth');
    expect(timeline).toContain('<SessionItem');
    expect(timeline).toContain('recentInbox');
  });
});
