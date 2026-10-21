// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InboxPanel } from './InboxPanel';
import { useSessionStore } from '../../stores/session-store';
import type { SessionMeta } from '@tower/shared';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), error: vi.fn(), quiet: vi.fn() }));
vi.mock('../../hooks/useDialog', () => ({ useConfirm: () => mocks.confirm }));
vi.mock('../../utils/toast', () => ({ toastError: mocks.error, toastQuiet: mocks.quiet }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../shared/RichContent', () => ({ RichContent: () => null }));
vi.mock('../../i18n', () => ({ default: { t: (key: string) => key } }));
const fetchMock = vi.fn();
const session = { id: 'archive-test', name: 'Active conversation', archived: false, tags: [], updatedAt: '2026-09-15T12:00:00Z', createdAt: '2026-09-15T12:00:00Z' } as SessionMeta;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
  mocks.confirm.mockResolvedValue(true);
  useSessionStore.setState({ sessions: [session], unreadSessions: new Set([session.id]), streamingSessions: new Set(), recentlyReadSessionUntil: {}, lastTurnTextBySession: {}, hydrateLatestAttentionFromServer: vi.fn().mockResolvedValue(undefined) });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const archiveRequests = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/archive'));

describe('Inbox archive on mobile and desktop', () => {
  it.each([true, false])('excludes an opened archived conversation (mobile=%s)', (isMobile) => {
    useSessionStore.setState({ isMobile, sessions: [{ ...session, archived: true }] });
    render(<InboxPanel />);
    expect(screen.queryByText(session.name)).toBeNull();
    expect(screen.queryByRole('button', { name: 'moveToArchive' })).toBeNull();
  });
  it('archives after confirmation and immediately removes the result', async () => {
    render(<InboxPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'moveToArchive' }));
    await waitFor(() => expect(archiveRequests()).toHaveLength(1));
    expect(archiveRequests()[0][1].method).toBe('POST');
    await waitFor(() => expect(screen.queryByText(session.name)).toBeNull());
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'sessionTrashSharedWarning' }));
    expect(mocks.quiet).toHaveBeenCalled();
  });
  it('does not archive on cancellation', async () => {
    mocks.confirm.mockResolvedValue(false);
    render(<InboxPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'moveToArchive' }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(archiveRequests()).toHaveLength(0);
    expect(screen.queryByText(session.name)).not.toBeNull();
  });
  it.each(['http', 'network'])('preserves the row and reports %s failure', async (failure) => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith('/archive')) {
        if (failure === 'network') throw new Error('offline');
        return { ok: false, status: 403 };
      }
      return { ok: true, json: async () => [] };
    });
    render(<InboxPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'moveToArchive' }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('sessionTrashDeleteFailed'));
    expect(screen.queryByText(session.name)).not.toBeNull();
    expect(mocks.quiet).not.toHaveBeenCalled();
  });
});
