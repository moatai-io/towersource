import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const navigation = readFileSync(new URL('./useSessionEventNavigation.ts', import.meta.url), 'utf8');

describe('cross-surface session event navigation', () => {
  it('is wired by App and owned by a dedicated hook', () => {
    expect(app).toContain('useSessionEventNavigation({ onSelectSession: handleSelectSession })');
    expect(app).not.toContain("window.addEventListener('kanban-select-session'");
    expect(navigation).toContain("window.addEventListener('kanban-select-session', handleNavigation)");
  });

  it('resolves missing session metadata and preserves requested anchors', () => {
    expect(navigation).toContain('findSessionByKey(useSessionStore.getState().sessions, sessionKey)');
    expect(navigation).toContain('fetch(`${API_BASE}/sessions/${key}`');
    expect(navigation).toContain("useFileStore.getState().openChatTab(session.id, { forceNew: true })");
    expect(navigation).toContain("window.dispatchEvent(new HashChangeEvent('hashchange'))");
  });
});
