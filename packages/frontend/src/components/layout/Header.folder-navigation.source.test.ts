import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './Header.tsx'), 'utf8');

describe('Header desktop folder navigation', () => {
  it('shows AI team and folder without duplicate Work or retired Channel tabs', () => {
    expect(source).toContain("{ key: 'ai', label: t('conversationsNav'), badge: 0 }");
    expect(source).not.toContain("{ key: 'work'");
    expect(source).toContain("{ key: 'files', label: t('files'), badge: 0 }");
    expect(source).not.toContain("key: 'channel'");
    expect(source).not.toContain('totalRoomUnread');
  });

  it('resets the folder navigator to the current AI project whenever Folder is clicked', () => {
    expect(source).toContain("sessions.find((session) => session.id === activeSessionId)?.projectId || null");
    expect(source).toContain('useSettingsStore.getState().setCapabilityProjectId(currentProjectId)');
    expect(source).toContain("setSidebarTab('files')");
  });
});
