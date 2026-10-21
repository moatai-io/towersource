// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileOpenActions } from './useFileOpenActions';
import { useSessionStore } from '../stores/session-store';
import { useFileStore } from '../stores/file-store';

vi.mock('../utils/toast', () => ({ toastError: vi.fn() }));

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(r => { resolve = r; });
  return { promise, resolve };
}

const t = ((key: string) => key) as any;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('Viewer request after session change', () => {
  beforeEach(() => {
    useSessionStore.getState().setActiveSessionId('old-session');
    useFileStore.getState().closeAllTabs();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reveals a document update even when keyboard focus was not requested', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: '# Updated', language: 'markdown' }) }));
    useFileStore.getState().setContextPanelOpen(false);
    const { result } = renderHook(() => useFileOpenActions({ token: null, requestFile: vi.fn(), triggerArtifactFlash: vi.fn(), t }));
    act(() => result.current.handleFileClick('/workspace/update.md', { target: 'viewer', backgroundViewer: true, revealViewer: true }));
    await act(flush);
    expect(useFileStore.getState().contextPanelOpen).toBe(true);
    expect(useFileStore.getState().splitTabId).toBeTruthy();
    expect(useFileStore.getState().tabs.find(tab => tab.id === useFileStore.getState().splitTabId)?.content).toBe('# Updated');
  });

  it('does not reopen the old Viewer after its file read finishes in a fresh session', async () => {
    const request = deferredResponse();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(request.promise));
    const { result } = renderHook(() => useFileOpenActions({ token: null, requestFile: vi.fn(), triggerArtifactFlash: vi.fn(), t }));
    act(() => result.current.handleFileClick('/workspace/old.md', { split: 'right' }));
    act(() => {
      useSessionStore.getState().setActiveSessionId('fresh-session');
      useFileStore.getState().activateChatSlot();
      useFileStore.getState().setContextPanelOpen(false);
    });
    request.resolve({ ok: true, json: async () => ({ path: '/workspace/old.md', content: 'old result', language: 'markdown' }) } as Response);
    await act(async () => { await flush(); });
    expect(useFileStore.getState().contextPanelOpen).toBe(false);
    expect(useFileStore.getState().tabs.some(tab => tab.content === 'old result')).toBe(false);
  });

  it('ignores a late read even if the user returns to the same session before it resolves', async () => {
    const request = deferredResponse();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(request.promise));
    const { result } = renderHook(() => useFileOpenActions({ token: null, requestFile: vi.fn(), triggerArtifactFlash: vi.fn(), t }));
    act(() => result.current.handleFileClick('/workspace/old.md', { split: 'right' }));
    act(() => {
      useSessionStore.getState().setActiveSessionId('fresh-session');
      useFileStore.getState().openChatTab('fresh-session');
      useSessionStore.getState().setActiveSessionId('old-session');
      useFileStore.getState().openChatTab('old-session');
      useFileStore.getState().setContextPanelOpen(false);
    });
    request.resolve({ ok: true, json: async () => ({ path: '/workspace/old.md', content: 'late result', language: 'markdown' }) } as Response);
    await act(async () => { await flush(); });
    expect(useFileStore.getState().contextPanelOpen).toBe(false);
    expect(useFileStore.getState().tabs.some(tab => tab.content === 'late result')).toBe(false);
  });

  it('does not refocus the old Viewer on a late read failure', async () => {
    const request = deferredResponse();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(request.promise));
    const { result } = renderHook(() => useFileOpenActions({ token: null, requestFile: vi.fn(), triggerArtifactFlash: vi.fn(), t }));
    act(() => result.current.handleFileClick('/workspace/old.md', { split: 'right' }));
    act(() => {
      useSessionStore.getState().setActiveSessionId('fresh-session');
      useFileStore.getState().activateChatSlot();
      useFileStore.getState().setContextPanelOpen(false);
    });
    request.resolve({ ok: false, json: async () => ({ error: 'missing' }) } as Response);
    await act(async () => { await flush(); });
    expect(useFileStore.getState().contextPanelOpen).toBe(false);
  });
});
