// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailInvitationManagement } from './EmailInvitationManagement';

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock('../../hooks/useDialog', () => ({ useConfirm: () => confirm }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); confirm.mockReset(); confirm.mockResolvedValue(true); });
const response = (data: unknown, ok = true) => ({ ok, json: async () => data });

describe('email member invitations', () => {
  it('invites using only email and role, without administrator-supplied passwords', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([]));
    vi.stubGlobal('fetch', fetchMock);
    render(<EmailInvitationManagement roles={['member', 'admin']} token="test-token" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('초대할 이메일'), { target: { value: 'person@example.com' } });
    fireEvent.click(screen.getByText('초대 메일 보내기'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('발송'));
    const [, options] = fetchMock.mock.calls.find(([, options]) => options.method === 'POST')!;
    expect(JSON.parse(options.body)).toEqual({ email: 'person@example.com', role: 'member' });
    expect(document.querySelector('input[type=password]')).toBeNull();
  });

  it('shows expired and accepted invitations and sends resend/cancel to the existing API', async () => {
    const rows = [
      { id: 1, email: 'pending@example.com', role: 'member', status: 'pending', expires_at: '2000-01-01' },
      { id: 2, email: 'accepted@example.com', role: 'member', status: 'accepted', expires_at: '2000-01-01' },
    ];
    const fetchMock = vi.fn().mockResolvedValue(response(rows));
    vi.stubGlobal('fetch', fetchMock);
    render(<EmailInvitationManagement roles={['member']} />);
    await screen.findByText('pending@example.com');
    expect(screen.getByText('member · 만료')).toBeTruthy();
    expect(screen.getByText('member · 수락 완료')).toBeTruthy();
    fireEvent.click(screen.getByText('재발송'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/account-email-invitations/1/resend', expect.objectContaining({ method: 'POST' })));
    await waitFor(() => expect((screen.getByText('취소') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText('취소'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/account-email-invitations/1/cancel', expect.objectContaining({ method: 'POST' })));
  });

  it('reports provider errors without claiming mail delivery succeeded', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response([])).mockResolvedValueOnce(response({ error: 'Email delivery unavailable' }, false)).mockResolvedValue(response([]));
    vi.stubGlobal('fetch', fetchMock);
    render(<EmailInvitationManagement roles={['member']} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('초대할 이메일'), { target: { value: 'person@example.com' } });
    fireEvent.click(screen.getByText('초대 메일 보내기'));
    expect((await screen.findByRole('alert')).textContent).toContain('Email delivery unavailable');
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('refreshes the cancelled invitation and removes pending actions', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([{ id: 1, email: 'person@example.com', role: 'member', status: 'pending', expires_at: '' }]))
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response([{ id: 1, email: 'person@example.com', role: 'member', status: 'cancelled', expires_at: '' }]));
    vi.stubGlobal('fetch', fetchMock);
    render(<EmailInvitationManagement roles={['member']} />);
    fireEvent.click(await screen.findByText('취소'));
    expect((await screen.findByRole('status')).textContent).toContain('초대를 취소했습니다.');
    await screen.findByText(/취소됨/);
    expect(screen.queryByText('취소')).toBeNull();
    expect(screen.queryByText('재발송')).toBeNull();
  });

  it.each([403, 404, 500])('shows cancellation failure (%s) without a success notice', async status => {
    const rows = [{ id: 1, email: 'person@example.com', role: 'member', status: 'pending', expires_at: '' }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(rows))
      .mockResolvedValueOnce({ ok: false, status, json: async () => ({ error: 'Cancellation rejected' }) })
      .mockResolvedValueOnce(response(rows));
    vi.stubGlobal('fetch', fetchMock);
    render(<EmailInvitationManagement roles={['member']} />);
    fireEvent.click(await screen.findByText('취소'));
    expect((await screen.findByRole('alert')).textContent).toContain('Cancellation rejected');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText(/수락 대기/)).toBeTruthy();
  });

  it('does not request cancellation when confirmation is declined', async () => {
    confirm.mockResolvedValueOnce(false);
    const fetchMock = vi.fn().mockResolvedValue(response([{ id: 1, email: 'person@example.com', role: 'member', status: 'pending', expires_at: '' }]));
    vi.stubGlobal('fetch', fetchMock);
    render(<EmailInvitationManagement roles={['member']} />);
    fireEvent.click(await screen.findByText('취소'));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

});
