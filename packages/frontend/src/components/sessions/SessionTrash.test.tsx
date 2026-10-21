// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTrash } from './SessionTrash';
const merge = vi.hoisted(() => vi.fn());
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../stores/session-store', () => ({ useSessionStore: { getState: () => ({ mergeSessions: merge }) } }));
const fetchMock = vi.fn();
const reply = (data: unknown, ok = true) => ({ ok, json: async () => data });
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('fetch', fetchMock); localStorage.setItem('token', 'test-token'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('Session Trash rendering and clicks', () => {
  it('loads an empty list without search and closes', async () => {
    fetchMock.mockResolvedValue(reply([])); const close = vi.fn(); render(<SessionTrash onClose={close} />);
    await screen.findByText('sessionTrashEmpty');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/sessions/archived');
    fireEvent.click(screen.getByText('common:close')); expect(close).toHaveBeenCalled();
  });
  it('restores, merges into sidebar, and reloads without the restored row', async () => {
    fetchMock.mockResolvedValueOnce(reply([{ id: 's1', name: 'Deleted' }])).mockResolvedValueOnce(reply({ session: { id: 's1', name: 'Deleted' } })).mockResolvedValueOnce(reply([]));
    const view = render(<SessionTrash onClose={() => {}} />);
    await screen.findByText('Deleted'); fireEvent.click(screen.getByText('sessionTrashRestore'));
    await screen.findByText('sessionTrashEmpty');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/sessions/s1/restore');
    expect(fetchMock.mock.calls[1][1].method).toBe('POST');
    expect(merge).toHaveBeenCalledWith([{ id: 's1', name: 'Deleted' }]);
    view.unmount(); render(<SessionTrash onClose={() => {}} />);
    await screen.findByText('sessionTrashEmpty');
  });
  it('opens in the current view through the selection callback without unarchiving', async () => {
    const session = { id: 's1', name: 'Archived', archived: true };
    const select = vi.fn();
    fetchMock.mockResolvedValue(reply([session]));
    render(<SessionTrash onClose={() => {}} onSelectSession={select} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Archived · sessionArchiveOpen' }));
    expect(select).toHaveBeenCalledWith(session);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('heading', { name: 'archivedSessionsTitle' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(merge).not.toHaveBeenCalled();
  });
  it('preserves the row on restore failure', async () => {
    fetchMock.mockResolvedValueOnce(reply([{ id: 's1', name: 'Deleted' }])).mockResolvedValueOnce(reply({}, false));
    render(<SessionTrash onClose={() => {}} />); await screen.findByText('Deleted');
    fireEvent.click(screen.getByText('sessionTrashRestore')); await screen.findByRole('alert');
    expect(screen.queryByText('Deleted')).not.toBeNull(); expect(merge).not.toHaveBeenCalled();
  });
  it('shows load errors and supports retry without a false empty state', async () => {
    fetchMock.mockResolvedValueOnce(reply({}, false)).mockResolvedValueOnce(reply([]));
    render(<SessionTrash onClose={() => {}} />); await screen.findByRole('alert');
    expect(screen.queryByText('sessionTrashEmpty')).toBeNull(); fireEvent.click(screen.getByText('sessionTrashRetry'));
    await screen.findByText('sessionTrashEmpty');
  });
  it('does not offer worker lifecycle restore', async () => {
    fetchMock.mockResolvedValue(reply([{ id: 'w1', name: 'Worker', agent: { workerId: 'w1' } }]));
    render(<SessionTrash onClose={() => {}} />); await screen.findByText('Worker');
    expect((screen.getByText('sessionTrashRestore') as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
