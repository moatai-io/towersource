// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SecretariatPopup, popupBlocked } from './SecretariatPopup';
import { loadSecretariat, respondSecretariat } from './secretariat-api';
vi.mock('./secretariat-api', () => ({ loadSecretariat: vi.fn(), respondSecretariat: vi.fn() }));
vi.mock('../../stores/session-store', () => ({ useSessionStore: { getState: () => ({ streamingSessions: new Set() }) } }));
const proposal = { id: 'p', title: '제안 제목', body: '검토할까요?', readAt: null, shownAt: null, sessionId: 's', projectId: 'p', createdAt: '' };
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.mocked(loadSecretariat).mockResolvedValue({ enabled: true, pausedReason: 'unread_proposal', proposals: [proposal] });
  vi.mocked(respondSecretariat).mockResolvedValue(new Response());
});
afterEach(cleanup);
it('claims once, shows body, close never acknowledges', async () => {
  render(<SecretariatPopup />);
  await screen.findByRole('dialog');
  expect(respondSecretariat).toHaveBeenCalledWith('p', 'show', expect.any(AbortSignal));
  fireEvent.click(screen.getByLabelText('제안 닫기'));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(respondSecretariat).toHaveBeenCalledTimes(1);
});
it('does not repeat a previously presented proposal', async () => {
  vi.mocked(loadSecretariat).mockResolvedValue({ enabled: true, pausedReason: null, proposals: [{ ...proposal, shownAt: 'now' }] });
  render(<SecretariatPopup />);
  await waitFor(() => expect(loadSecretariat).toHaveBeenCalled());
  expect(respondSecretariat).not.toHaveBeenCalled();
});
it('defers while another modal exists, including legacy overlays', () => {
  const { unmount } = render(<div className="fixed inset-0">settings</div>);
  expect(popupBlocked()).toBe(true); unmount();
  render(<><div role="dialog">approval</div><SecretariatPopup /></>);
  expect(loadSecretariat).not.toHaveBeenCalled();
});
it('skip records explicit response', async () => {
  render(<SecretariatPopup />); await screen.findByRole('dialog');
  fireEvent.click(screen.getByText('이번 제안 넘기기'));
  await waitFor(() => expect(respondSecretariat).toHaveBeenCalledWith('p', 'skip'));
});
it('never opens after a failed presentation claim', async () => {
  vi.mocked(respondSecretariat).mockRejectedValue(new Error('claimed in other tab'));
  render(<SecretariatPopup />); await waitFor(() => expect(respondSecretariat).toHaveBeenCalled());
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('long notes expand without losing the close control', async () => {
  const body = '핵심 요지입니다.\n\n' + '상세 근거입니다. '.repeat(120);
  vi.mocked(loadSecretariat).mockResolvedValue({ enabled: true, pausedReason: null, proposals: [{ ...proposal, body }] });
  render(<SecretariatPopup />); await screen.findByRole('dialog');
  fireEvent.click(screen.getByText('제안 자세히 보기'));
  expect(document.getElementById('secretariat-popup-body')?.textContent).toBe(body);
  expect(screen.getByLabelText('제안 닫기')).toBeTruthy();
  fireEvent.click(screen.getByText('상세 접기'));
  expect(document.getElementById('secretariat-popup-body')?.textContent?.length).toBeLessThan(600);
});

it('keeps inbox-only notes out of automatic popups', async () => {
  vi.mocked(loadSecretariat).mockResolvedValue({ enabled: true, pausedReason: 'unread_proposal', proposals: [{ ...proposal, delivery: 'inbox' }] });
  render(<SecretariatPopup />);
  await waitFor(() => expect(loadSecretariat).toHaveBeenCalled());
  expect(respondSecretariat).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});
