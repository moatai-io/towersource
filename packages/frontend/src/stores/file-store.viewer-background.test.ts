// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

function tokenFor(username: string) {
  return `x.${btoa(JSON.stringify({ username }))}.x`;
}

describe('file-store background Viewer tabs', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('token', tokenFor('viewer-test-user'));
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `tab-${Math.random()}`) });
  });

  it('adds a Viewer tab without opening or focusing a collapsed pane', async () => {
    const { useFileStore } = await import('./file-store');

    useFileStore.getState().openTab('/workspace/report.md', '# report', 'markdown', 'utf-8', {
      forceNew: true,
      split: 'right',
      backgroundSplit: true,
    });

    const state = useFileStore.getState();
    expect(state.tabs).toEqual([expect.objectContaining({ path: '/workspace/report.md', pane: 'extra' })]);
    expect(state.contextPanelOpen).toBe(false);
    expect(state.splitTabId).toBeNull();
    expect(state.activeFilePane).toBe('main');
  });

  it('replaces the current unpinned Viewer preview for an inactive-session delivery', async () => {
    const { useFileStore } = await import('./file-store');
    const store = useFileStore.getState();
    store.openTab('/workspace/current.md', 'current', 'markdown', 'utf-8', { split: 'right' });
    const currentViewerId = useFileStore.getState().splitTabId;

    useFileStore.getState().openTab('/workspace/background.md', 'background', 'markdown', 'utf-8', {
      forceNew: true,
      split: 'right',
      backgroundSplit: true,
    });

    const state = useFileStore.getState();
    expect(state.contextPanelOpen).toBe(true);
    expect(state.splitTabId).toBe(currentViewerId);
    expect(state.tabs.filter((tab) => tab.pane === 'extra')).toEqual([
      expect.objectContaining({ id: currentViewerId, path: '/workspace/background.md', pinned: false }),
    ]);
  });

  it('preserves pinned Viewer tabs and keeps only one unpinned preview', async () => {
    const { useFileStore } = await import('./file-store');
    const store = useFileStore.getState();
    store.openTab('/workspace/pinned.md', 'pinned', 'markdown', 'utf-8', { split: 'right' });
    const pinnedId = useFileStore.getState().splitTabId!;
    store.pinTab(pinnedId);

    store.openTab('/workspace/first-preview.md', 'first', 'markdown', 'utf-8', { split: 'right' });
    store.openTab('/workspace/latest-preview.md', 'latest', 'markdown', 'utf-8', {
      forceNew: true,
      split: 'right',
      backgroundSplit: true,
    });

    const viewerTabs = useFileStore.getState().tabs.filter((tab) => tab.pane === 'extra');
    expect(viewerTabs).toEqual([
      expect.objectContaining({ path: '/workspace/pinned.md', pinned: true }),
      expect.objectContaining({ path: '/workspace/latest-preview.md', pinned: false }),
    ]);
    expect(viewerTabs.filter((tab) => !tab.pinned)).toHaveLength(1);
  });
});
