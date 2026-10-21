// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { ChangePasswordModal, MyProfileModal } from './UserSelfModals';

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(async () => { await i18n.changeLanguage('ko'); });

it.each([
  ['ko', '현재 비밀번호가 올바르지 않습니다.'],
  ['en', 'Your current password is incorrect.'],
])('shows the password API error in the selected %s language without treating failure as success', async (language, message) => {
  await i18n.changeLanguage(language);
  const fetcher = vi.fn(async (_url: unknown, _init: RequestInit) => new Response(JSON.stringify({ error: 'Current password is incorrect' }), { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  const onPasswordChanged = vi.fn();
  const onClose = vi.fn();
  const { container } = render(<ChangePasswordModal token="synthetic-token" onClose={onClose} onPasswordChanged={onPasswordChanged} />);
  const inputs = container.querySelectorAll('input');
  fireEvent.change(inputs[0], { target: { value: 'old-password' } });
  fireEvent.change(inputs[1], { target: { value: 'new-password' } });
  fireEvent.change(inputs[2], { target: { value: 'new-password' } });
  await act(async () => { fireEvent.submit(container.querySelector('form')!); });
  expect(screen.getByText(message)).toBeTruthy();
  expect(onPasswordChanged).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({ oldPassword: 'old-password', newPassword: 'new-password' });
});

it('hides unknown password diagnostics behind a neutral failure', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'upstream secret diagnostic' }), { status: 500 })));
  const { container } = render(<ChangePasswordModal onClose={vi.fn()} onPasswordChanged={vi.fn()} />);
  const inputs = container.querySelectorAll('input');
  fireEvent.change(inputs[0], { target: { value: 'old-password' } });
  fireEvent.change(inputs[1], { target: { value: 'new-password' } });
  fireEvent.change(inputs[2], { target: { value: 'new-password' } });
  await act(async () => { fireEvent.submit(container.querySelector('form')!); });
  expect(screen.getByText('요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.')).toBeTruthy();
  expect(screen.queryByText('upstream secret diagnostic')).toBeNull();
});

it('maps profile save errors through the same boundary and keeps the modal open', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ username: 'demo', displayName: 'Demo', affiliation: null })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'language must be en, ko, or null' }), { status: 400 }));
  vi.stubGlobal('fetch', fetcher);
  const onClose = vi.fn();
  await act(async () => { render(<MyProfileModal onClose={onClose} />); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'common:save' })); });
  expect(screen.getByText('사용할 언어를 다시 선택해 주세요.')).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
});
