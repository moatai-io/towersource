// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue || key }) }));
vi.mock('../../hooks/useMobileKeyboardViewport', () => ({ useMobileKeyboardViewport: () => ({}) }));
import { LoginPage } from './LoginPage';
import { PasswordResetLinkPage } from './PasswordResetLinkPage';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

it('offers verified email or ID login and a generic password recovery request', async () => {
  vi.stubGlobal('matchMedia',vi.fn(()=>({matches:false})));
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:true})));vi.stubGlobal('fetch',fetcher);
  render(<LoginPage isSetup={false} onLogin={async()=>{}} />);
  expect(screen.getByLabelText('로그인 ID 또는 확인된 이메일')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'비밀번호를 잊으셨나요?'}));
  expect(screen.queryByLabelText('password')).toBeNull();
  fireEvent.change(screen.getByLabelText('확인된 계정 이메일'),{target:{value:'unknown@example.com'}});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'재설정 링크 요청'})));
  expect(fetcher).toHaveBeenCalledWith('/api/auth/password-reset/request',expect.objectContaining({method:'POST'}));
  expect(screen.getByRole('status').textContent).toContain('계정이라면');
});
it('strips reset token, never consumes on mount, and submits only the matching new password',async()=>{
  window.history.replaceState({},'', '/?passwordReset=fixture-token');
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:true}),{status:200}));vi.stubGlobal('fetch',fetcher);
  render(<PasswordResetLinkPage/>);
  expect(window.location.search).toBe('');expect(fetcher).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('새 비밀번호'),{target:{value:'new-fixture-123'}});
  fireEvent.change(screen.getByLabelText('비밀번호 확인'),{target:{value:'new-fixture-123'}});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'비밀번호 변경'})));
  expect(fetcher).toHaveBeenCalledWith('/api/auth/password-reset/confirm',expect.objectContaining({method:'POST',referrerPolicy:'no-referrer',body:JSON.stringify({token:'fixture-token',password:'new-fixture-123'})}));
  expect(screen.getByRole('status').textContent).toContain('다시 로그인');
  expect(screen.queryByRole('button',{name:'비밀번호 변경'})).toBeNull();
});
it('keeps expired link failures visible without issuing any session',async()=>{
  window.history.replaceState({},'', '/?passwordReset=expired-token');
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:400})));
  render(<PasswordResetLinkPage/>);
  fireEvent.change(screen.getByLabelText('새 비밀번호'),{target:{value:'new-fixture-123'}});
  fireEvent.change(screen.getByLabelText('비밀번호 확인'),{target:{value:'new-fixture-123'}});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'비밀번호 변경'})));
  expect(screen.getByRole('alert').textContent).toContain('만료');
});
