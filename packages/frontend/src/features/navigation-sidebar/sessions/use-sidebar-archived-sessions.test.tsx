// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { combineSidebarSessions, useSidebarArchivedSessions, type SidebarSessionMeta } from './use-sidebar-archived-sessions';
import { buildSidebarSessionListModel } from './sidebar-session-list-model';
import type { Project } from '../../../stores/project-store';

const fetchMock = vi.fn();
const row = (id: string, extra: Partial<SidebarSessionMeta> = {}): SidebarSessionMeta => ({ id, name: id, ownerUsername: 'alice', updatedAt: '2026-09-13T00:00:00Z', ...extra } as SidebarSessionMeta);
const reply = (data: unknown, ok = true) => ({ ok, json: async () => data });
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('fetch', fetchMock); localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('local Sidebar archive snapshot', () => {
  it('does not fetch until enabled, then loads without a search query and hides immediately on disable', async () => {
    fetchMock.mockResolvedValue(reply([row('archived')]));
    const hook = renderHook(({ enabled }) => useSidebarArchivedSessions(enabled, 'live'), { initialProps: { enabled: false } });
    expect(fetchMock).not.toHaveBeenCalled();
    hook.rerender({ enabled: true });
    await waitFor(() => expect(hook.result.current.sessions).toEqual([row('archived', { archived: true })]));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/sessions/archived');
    hook.rerender({ enabled: false });
    expect(hook.result.current.sessions).toEqual([]);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('exposes request failure and retries successfully', async () => {
    fetchMock.mockResolvedValueOnce(reply({}, false)).mockResolvedValueOnce(reply([row('a')]));
    const hook = renderHook(() => useSidebarArchivedSessions(true, 'live'));
    await waitFor(() => expect(hook.result.current.error).toBe(true));
    expect(hook.result.current.loading).toBe(false);
    act(() => hook.result.current.retry());
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    expect(hook.result.current.error).toBe(false);
  });

  it('rejects malformed responses instead of treating them as an empty archive', async () => {
    fetchMock.mockResolvedValue(reply({ sessions: [] }));
    const hook = renderHook(() => useSidebarArchivedSessions(true, ''));
    await waitFor(() => expect(hook.result.current.error).toBe(true));
  });

  it('ignores late responses after disable and re-enable', async () => {
    let resolveOld!: (response: ReturnType<typeof reply>) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce(reply([row('new')]));
    const hook = renderHook(({ enabled }) => useSidebarArchivedSessions(enabled, ''), { initialProps: { enabled: true } });
    hook.rerender({ enabled: false });
    hook.rerender({ enabled: true });
    await waitFor(() => expect(hook.result.current.sessions[0]?.id).toBe('new'));
    await act(async () => resolveOld(reply([row('stale')])));
    expect(hook.result.current.sessions[0]?.id).toBe('new');
  });

  it('refreshes on live membership changes and explicit restore notifications', async () => {
    fetchMock.mockResolvedValueOnce(reply([row('a')])).mockResolvedValueOnce(reply([])).mockResolvedValueOnce(reply([row('b')]));
    const hook = renderHook(({ ids }) => useSidebarArchivedSessions(true, ids), { initialProps: { ids: '' } });
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    hook.rerender({ ids: 'a' });
    await waitFor(() => expect(hook.result.current.sessions).toEqual([]));
    act(() => window.dispatchEvent(new Event('tower-session-archive-changed')));
    await waitFor(() => expect(hook.result.current.sessions[0]?.id).toBe('b'));
  });

  it('keeps live rows authoritative and never mutates either input', () => {
    const live = [row('restored'), row('live')];
    const archived = [row('restored', { archived: true }), row('archived', { archived: true })];
    const combined = combineSidebarSessions(live, archived, true);
    expect(combined.find(item => item.id === 'restored')?.archived).toBeUndefined();
    expect(combined).toHaveLength(3);
    expect(combineSidebarSessions(live, archived, false)).toEqual(live);
    expect(live).toHaveLength(2);
    expect(archived[0].archived).toBe(true);
    expect(combineSidebarSessions([...live, archived[1]], [], false)).toEqual(live);
  });

  it('applies the existing owner/favorite and project grouping rules to the combined list and archive search', () => {
    const sessions = combineSidebarSessions([row('live')], [row('keep', { archived: true, favorite: true, projectId: 'p' }), row('other', { archived: true, favorite: true, ownerUsername: 'bob' })], true);
    const input = { sessions, projects: [{ id: 'p', createdAt: '', sortOrder: 0 } as Project], searchResults: null, searchQuery: '', kind: 'all' as const, filterMy: true, filterFav: true, filterDone: false, filterRunning: false, filterAwaiting: false, currentUsername: 'alice', unreadSessionIds: new Set<string>(), streamingSessionIds: new Set<string>(), awaitingSessionIds: new Set<string>() };
    const model = buildSidebarSessionListModel(input);
    expect(model.filteredSessions.map(item => item.id)).toEqual(['keep']);
    expect(model.groupedSessions?.groups[0].sessions[0].id).toBe('keep');
    expect(buildSidebarSessionListModel({ ...input, searchQuery: 'keep', searchResults: [{ sessionId: 'keep' }] }).filteredSessions.map(item => item.id)).toEqual(['keep']);
  });
});
