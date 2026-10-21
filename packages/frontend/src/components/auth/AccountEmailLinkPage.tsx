import { useEffect, useState, type FormEvent } from 'react';
import { authErrorMessage } from '../../utils/auth-error-message';

type Invite = { maskedEmail: string; role: string; displayName?: string | null; affiliation?: string | null; expiresAt: string };
type Phase = 'loading' | 'form' | 'verifying' | 'success' | 'error';

/** Public, single-use email link flow. Never put the token into logs or local storage. */
export function AccountEmailLinkPage() {
  const params = new URLSearchParams(window.location.search);
  const invitation = params.get('accountInvitation');
  const verification = params.get('accountEmailVerification');
  const [phase, setPhase] = useState<Phase>('loading');
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [affiliation, setAffiliation] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteToken] = useState(invitation);
  const [isInvitation] = useState(Boolean(invitation));

  useEffect(() => {
    let active = true;
    // Strip the secret from history before any network request or further navigation.
    window.history.replaceState(window.history.state, '', window.location.pathname);
    if ((!invitation && !verification) || (invitation && verification)) {
      setError('유효한 이메일 링크가 아닙니다. 관리자에게 새 링크를 요청하세요.'); setPhase('error'); return;
    }
    (async () => {
      try {
        const response = invitation
          ? await fetch(`/api/auth/account-invitation/${encodeURIComponent(invitation)}`, { cache: 'no-store', referrerPolicy: 'no-referrer' })
          : await fetch('/api/auth/account-email/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: verification }), cache: 'no-store', referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error('링크가 만료되었거나 이미 사용되었습니다. 관리자에게 새 링크를 요청하세요.');
        const data = await response.json();
        if (!active) return;
        if (invitation) { setInvite(data); setDisplayName(data.displayName || ''); setAffiliation(data.affiliation || ''); setPhase('form'); }
        else setPhase('success');
      } catch (cause) {
        if (active) { setError(cause instanceof Error ? cause.message : '링크를 확인할 수 없습니다.'); setPhase('error'); }
      }
    })();
    return () => { active = false; };
  // Link tokens are captured on first render. Re-render must not consume verification twice.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const accept = async (event: FormEvent) => {
    event.preventDefault();
    if (!inviteToken || busy) return;
    if (password.length < 8 || password !== passwordConfirm || !displayName.trim()) {
      setError('표시 이름을 입력하고 8자 이상 비밀번호가 일치하는지 확인하세요.'); return;
    }
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/auth/account-invitation/${encodeURIComponent(inviteToken)}/accept`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', referrerPolicy: 'no-referrer',
        body: JSON.stringify({ username: username.trim(), password, passwordConfirm, displayName: displayName.trim(), affiliation: affiliation.trim() }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(response.status === 404 ? '링크가 만료되었거나 이미 사용되었습니다. 관리자에게 새 링크를 요청하세요.' : authErrorMessage(data.error, data.code));
      }
      setPassword(''); setPasswordConfirm(''); setPhase('success');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '계정을 설정할 수 없습니다.'); }
    finally { setBusy(false); }
  };

  return <main className="min-h-screen bg-surface-950 text-gray-100 flex items-center justify-center p-5">
    <section className="w-full max-w-md rounded-xl border border-surface-700 bg-surface-900 p-6 space-y-5" aria-label="계정 이메일 확인">
      <h1 className="text-xl font-bold">{isInvitation ? 'Tower 계정 설정' : '계정 이메일 확인'}</h1>
      {phase === 'loading' && <p role="status">링크를 확인하고 있습니다…</p>}
      {phase === 'success' && <p role="status">{isInvitation ? '계정 설정이 완료되었습니다. 로그인하세요.' : '이메일 확인이 완료되었습니다.'}</p>}
      {phase === 'verifying' && <p role="status">확인 중입니다…</p>}
      {error && <p role="alert" className="text-red-300">{error}</p>}
      {phase === 'form' && invite && <form onSubmit={accept} className="space-y-4">
        <p>초대받은 이메일: <strong>{invite.maskedEmail}</strong></p>
        <p>역할: <strong>{invite.role}</strong></p>
        <p className="text-sm text-gray-400">이메일과 역할은 초대에서 지정되며 변경할 수 없습니다.</p>
        <label className="block">로그인 ID<input className="mt-1 block w-full rounded border border-surface-600 bg-surface-800 p-2" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required /></label>
        <label className="block">비밀번호<input className="mt-1 block w-full rounded border border-surface-600 bg-surface-800 p-2" type="password" minLength={8} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" required /></label>
        <label className="block">비밀번호 확인<input className="mt-1 block w-full rounded border border-surface-600 bg-surface-800 p-2" type="password" minLength={8} value={passwordConfirm} onChange={e => setPasswordConfirm(e.target.value)} autoComplete="new-password" required /></label>
        <label className="block">표시 이름<input className="mt-1 block w-full rounded border border-surface-600 bg-surface-800 p-2" value={displayName} onChange={e => setDisplayName(e.target.value)} required /></label>
        <label className="block">소속 (선택)<input className="mt-1 block w-full rounded border border-surface-600 bg-surface-800 p-2" value={affiliation} onChange={e => setAffiliation(e.target.value)} /></label>
        <button disabled={busy} className="w-full rounded bg-primary-600 p-2 font-semibold disabled:opacity-50">{busy ? '설정 중…' : '계정 설정 완료'}</button>
      </form>}
      {(phase === 'success' || phase === 'error') && <a className="text-primary-300 underline" href="/">로그인 화면으로 이동</a>}
    </section>
  </main>;
}
