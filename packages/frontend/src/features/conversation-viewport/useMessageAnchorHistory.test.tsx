// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessageAnchorHistory } from './useMessageAnchorHistory';
const state = vi.hoisted(() => ({ chat: {} as any, session: { activeSessionId: 'session' }, info: vi.fn() }));
vi.mock('../../stores/chat-store', () => ({ useChatStore: { getState: () => state.chat } }));
vi.mock('../../stores/session-store', () => ({ useSessionStore: { getState: () => state.session } }));
vi.mock('../../utils/toast', () => ({ toastInfo: state.info }));
describe('message anchor history', () => {
  beforeEach(() => {
    state.chat = { sessionId: 'session', messages: [], sessionLoading: false, hasMoreMessages: true, oldestMessageId: 'page1' };
    state.session.activeSessionId = 'session';
    state.info.mockReset();
    window.location.hash = '#m-abcdefgh';
  });
  const options = (loadMore: any) => ({ sessionId: 'session', hash: '#m-abcdefgh', ready: true, targetReady: false, loadMore });
  it('loads successive pages until the requested message is present', async () => {
    const load = vi.fn(async () => {
      state.chat = { ...state.chat, oldestMessageId: `page${load.mock.calls.length + 1}`,
        messages: load.mock.calls.length === 2 ? [{ shortId: 'abcdefgh' }] : [] };
    });
    renderHook(() => useMessageAnchorHistory(options(load)));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(state.info).not.toHaveBeenCalled();
  });
  it('reports a missing message when history is exhausted', async () => {
    const load = vi.fn(async () => { state.chat = { ...state.chat, hasMoreMessages: false }; });
    renderHook(() => useMessageAnchorHistory(options(load)));
    await waitFor(() => expect(state.info).toHaveBeenCalledOnce());
    expect(load).toHaveBeenCalledOnce();
  });
  it('stops on a failed request without repeatedly loading the same page', async () => {
    const load = vi.fn(async () => {});
    renderHook(() => useMessageAnchorHistory(options(load)));
    await waitFor(() => expect(state.info).toHaveBeenCalledOnce());
    expect(load).toHaveBeenCalledOnce();
  });
  it('stops when the session changes during a request', async () => {
    const load = vi.fn(async () => { state.session.activeSessionId = 'other'; });
    renderHook(() => useMessageAnchorHistory(options(load)));
    await waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(state.info).not.toHaveBeenCalled();
  });
  it('does not load while initial session data is loading or target is ready', () => {
    const load = vi.fn();
    renderHook(() => useMessageAnchorHistory({ ...options(load), ready: false }));
    renderHook(() => useMessageAnchorHistory({ ...options(load), targetReady: true }));
    expect(load).not.toHaveBeenCalled();
  });
});
