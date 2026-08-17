// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

function tokenFor(username: string) {
  return `x.${btoa(JSON.stringify({ username }))}.x`;
}

describe('file-store system tab pin policy', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('token', tokenFor('system-tab-test-user'));
    let nextId = 0;
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `system-tab-${++nextId}`) });
  });

  it('opens teammate homes and schedule details as temporary tabs', async () => {
    const { useFileStore } = await import('./file-store');
    const store = useFileStore.getState();

    store.openSystemTab('projectFiles', { refId: 'project-1', title: '팀원 홈' });
    store.openSystemTab('schedule', { refId: 'automation-1', title: '아침 브리핑' });

    expect(useFileStore.getState().systemTabs).toEqual([
      expect.objectContaining({ kind: 'projectFiles', refId: 'project-1', pinned: false }),
      expect.objectContaining({ kind: 'schedule', refId: 'automation-1', pinned: false }),
    ]);
  });

  it('reuses the temporary schedule preview while preserving explicitly pinned schedules', async () => {
    const { useFileStore } = await import('./file-store');
    const store = useFileStore.getState();

    store.openSystemTab('schedule', { refId: 'automation-1', title: '첫 작업' });
    const previewId = useFileStore.getState().activeSystemTabId!;
    store.pinSystemTab(previewId);

    store.openSystemTab('schedule', { refId: 'automation-2', title: '둘째 작업' });
    const secondPreviewId = useFileStore.getState().activeSystemTabId!;
    store.openSystemTab('schedule', { refId: 'automation-3', title: '셋째 작업' });

    const schedules = useFileStore.getState().systemTabs.filter((tab) => tab.kind === 'schedule');
    expect(schedules).toEqual([
      expect.objectContaining({ id: previewId, refId: 'automation-1', pinned: true }),
      expect.objectContaining({ id: secondPreviewId, refId: 'automation-3', pinned: false }),
    ]);
  });

  it('keeps Publishing Hub as the durable singleton exception', async () => {
    const { useFileStore } = await import('./file-store');

    useFileStore.getState().openSystemTab('publishing');

    expect(useFileStore.getState().systemTabs).toEqual([
      expect.objectContaining({ kind: 'publishing', pinned: true }),
    ]);
  });
});
