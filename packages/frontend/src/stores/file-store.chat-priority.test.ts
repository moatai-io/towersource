// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

function tokenFor(username: string) {
  return `x.${btoa(JSON.stringify({ username }))}.x`;
}

describe('chat priority over historical files', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('token', tokenFor('chat-priority-test-user'));
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `tab-${Math.random()}`) });
  });

  it('does not promote an old file when the last chat tab is removed, including stale-list cleanup', async () => {
    const { useFileStore } = await import('./file-store');
    const { useSessionStore } = await import('./session-store');
    const files = useFileStore.getState();
    files.openTab('/workspace/old.md', 'old', 'markdown', 'utf-8');
    files.openChatTab('fresh-session');
    useSessionStore.getState().setActiveSessionId('fresh-session');
    const tab = useFileStore.getState().chatTabs[0];
    expect(useFileStore.getState().activeTabId).toBeNull();

    files.closeChatTab(tab.id);
    expect(useFileStore.getState().activeTabId).toBeNull();
    expect(useFileStore.getState().tabs.map(item => item.path)).toContain('/workspace/old.md');
  });

  it('does not promote an old file when closing the active system tab', async () => {
    const { useFileStore } = await import('./file-store');
    const files = useFileStore.getState();
    files.openTab('/workspace/old.md', 'old', 'markdown', 'utf-8');
    files.openSystemTab('publishing');
    const systemId = useFileStore.getState().activeSystemTabId!;
    files.closeSystemTab(systemId);
    expect(useFileStore.getState().activeTabId).toBeNull();
    expect(useFileStore.getState().tabs).toHaveLength(1);
  });
});
