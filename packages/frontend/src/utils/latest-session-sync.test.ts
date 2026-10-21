import { afterEach, describe, expect, it, vi } from 'vitest';
const store = vi.hoisted(() => ({ setRecentSessions: vi.fn(), hydrateLatestAttentionFromServer: vi.fn(async () => {}) }));
vi.mock('../stores/session-store', () => ({ useSessionStore: { getState: () => store } }));
import { refreshLatestSessionSnapshot } from './latest-session-sync';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('latest session snapshot recovery', () => {
  it('coalesces concurrent recovery and refreshes attention even without an active chat', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'test-token' });
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => [{ id: 'chat' }, { id: 'room', roomId: 'r' }] }));
    vi.stubGlobal('fetch', fetcher);
    const first = refreshLatestSessionSnapshot();
    expect(refreshLatestSessionSnapshot()).toBe(first);
    await first;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.setRecentSessions).toHaveBeenCalledWith([{ id: 'chat' }], { requestedAt: expect.any(Number) });
    expect(store.hydrateLatestAttentionFromServer).toHaveBeenCalledTimes(1);
  });
  it('preserves the existing list on HTTP failure and allows the next recovery', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    const fetcher = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal('fetch', fetcher);
    await refreshLatestSessionSnapshot();
    expect(store.setRecentSessions).not.toHaveBeenCalled();
    await refreshLatestSessionSnapshot();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(store.hydrateLatestAttentionFromServer).toHaveBeenCalledTimes(2);
  });
});
