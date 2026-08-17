import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './Header.tsx'), 'utf8');

describe('Header desktop folder navigation', () => {
  it('shows AI team and folder without the retired Channel tab', () => {
    expect(source).toContain("{ key: 'ai', label: t('aiTeam') }");
    expect(source).toContain("{ key: 'files', label: t('files') }");
    expect(source).not.toContain("key: 'channel'");
    expect(source).not.toContain('totalRoomUnread');
  });

  it('resets the folder navigator to the current AI project whenever Folder is clicked', () => {
    expect(source).toContain("sessions.find((session) => session.id === activeSessionId)?.projectId || null");
    expect(source).toContain('useSettingsStore.getState().setCapabilityProjectId(currentProjectId)');
    expect(source).toContain("setSidebarTab('files')");
  });
});
