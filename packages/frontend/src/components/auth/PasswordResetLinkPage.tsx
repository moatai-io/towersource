import { useEffect, useState, type FormEvent } from 'react';

/** Password reset is a public one-use capability, not a login session. */
export function PasswordResetLinkPage() {
  const [resetToken] = useState(() => new URLSearchParams(window.location.search).get('passwordReset'));
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    // Strip the capability from browser history before any request. No GET endpoint consumes it.
    window.history.replaceState(window.history.state, '', window.location.pathname);
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!resetToken || password.length < 8 || password !== confirm) {
      setError('비밀번호를 8자 이상 입력하고 확인란과 일치시켜 주세요.'); return;
    }
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/password-reset/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        cache: 'no-store', referrerPolicy: 'no-referrer',
        body: JSON.stringify({ token: resetToken, password }),
      });
      if (!response.ok) throw new Error('링크가 만료되었거나 이미 사용됐습니다. 로그인 화면에서 다시 요청하세요.');
      setPassword(''); setConfirm(''); setDone(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '비밀번호를 변경하지 못했습니다.'); }
    finally { setBusy(false); }
  };
  return <main className="min-h-screen bg-surface-950 text-gray-100 flex items-center justify-center p-5">
    <section className="w-full max-w-md rounded-xl border border-surface-700 bg-surface-900 p-6 space-y-5" aria-label="비밀번호 재설정">
      <h1 className="text-xl font-bold">비밀번호 재설정</h1>
      {!resetToken && <p role="alert">링크가 올바르지 않습니다. 새 링크를 요청하세요.</p>}
      {done ? <p role="status">비밀번호를 변경했습니다. 다시 로그인하고 필요한 경우 이메일 인증 코드를 입력하세요.</p>
        : resetToken && <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-surface-300">새 비밀번호를 입력하세요. 완료해도 자동으로 로그인되지 않습니다.</p>
          <label className="block">새 비밀번호<input className="mt-1 block w-full rounded border border-surface-600 bg-surface-800 p-2" type="password" minLength={8} maxLength={1024} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
          <label className="block">비밀번호 확인<input className="mt-1 block w-full rounded border border-surface-600 bg-surface-800 p-2" type="password" minLength={8} maxLength={1024} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} required /></label>
          {error && <p role="alert" className="text-red-300">{error}</p>}
          <button disabled={busy} className="min-h-11 w-full rounded bg-primary-600 p-2 font-semibold disabled:opacity-50">{busy ? '변경 중…' : '비밀번호 변경'}</button>
        </form>}
      <a href="/" className="text-primary-300 underline">로그인 화면으로 이동</a>
    </section>
  </main>;
}
