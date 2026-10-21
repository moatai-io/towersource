// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionLifecycle } from './useSessionLifecycle';
import { useFileStore } from '../stores/file-store';
import { useSessionStore } from '../stores/session-store';
import { useChatStore } from '../stores/chat-store';

vi.mock('../utils/toast', () => ({ toastError: vi.fn(), toastQuiet: vi.fn() }));
const t = ((key: string) => key) as any;

describe('new session starts in chat, not an old document', () => {
  beforeEach(() => {
    useFileStore.getState().closeAllTabs();
    useSessionStore.getState().setActiveSessionId(null);
    useChatStore.getState().setSessionId(null);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('hides the old file immediately while the create request is pending or fails', async () => {
    const files = useFileStore.getState();
    files.openTab('/workspace/old.md', 'old', 'markdown', 'utf-8');
    files.openTab('/workspace/preview.md', '', 'markdown', 'utf-8', { split: 'right' });
    let resolve!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>(r => { resolve = r; })));
    const { result } = renderHook(() => useSessionLifecycle({ token: null, setActiveRuntimeSession: vi.fn(), confirmSessionArchive: vi.fn(), t }));
    let pending!: Promise<void>;
    act(() => { pending = result.current.handleNewSession(); });
    expect(useFileStore.getState().activeTabId).toBeNull();
    expect(useFileStore.getState().contextPanelOpen).toBe(false);
    await act(async () => { resolve({ ok: false } as Response); await pending; });
    expect(useFileStore.getState().activeTabId).toBeNull();
    expect(useFileStore.getState().tabs.map(tab => tab.path)).toContain('/workspace/old.md');
  });

  it('keeps old files as tabs but hides the foreground file and Viewer for a new session', async () => {
    const files = useFileStore.getState();
    files.openTab('/workspace/old.md', 'old', 'markdown', 'utf-8');
    files.openTab('/workspace/preview.md', 'preview', 'markdown', 'utf-8', { split: 'right' });
    expect(useFileStore.getState().activeTabId).not.toBeNull();
    expect(useFileStore.getState().contextPanelOpen).toBe(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'fresh-session', name: 'New', createdAt: new Date().toISOString() }) }));
    const { result } = renderHook(() => useSessionLifecycle({ token: null, setActiveRuntimeSession: vi.fn(), confirmSessionArchive: vi.fn(), t }));
    await act(async () => { await result.current.handleNewSession(); });
    expect(useSessionStore.getState().activeSessionId).toBe('fresh-session');
    expect(useChatStore.getState().sessionId).toBe('fresh-session');
    expect(useFileStore.getState().activeTabId).toBeNull();
    expect(useFileStore.getState().contextPanelOpen).toBe(false);
    expect(useFileStore.getState().tabs.map(tab => tab.path)).toEqual(expect.arrayContaining(['/workspace/old.md', '/workspace/preview.md']));
  });
});
