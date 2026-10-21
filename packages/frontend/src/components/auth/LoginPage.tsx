import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RunIndicator } from '../common/RunIndicator';
import { useMobileKeyboardViewport } from '../../hooks/useMobileKeyboardViewport';

interface LoginPageProps {
  isSetup: boolean;
  emailEnrollment?: {challengeId:string;emailRequired:boolean;maskedEmail:string;resendAvailableAt:string}|null;
  onEmailEnrollmentAction?: (action:'email'|'verify'|'resend'|'cancel',value?:string)=>Promise<boolean>;
  otpChallenge?: { challengeId: string; maskedEmail: string; resendAvailableAt: string } | null;
  onOtpAction?: (action: 'verify' | 'resend' | 'cancel', otp?: string) => Promise<boolean | void>;
  onLogin: (
    username: string,
    password: string,
    opts?: { displayName?: string; affiliation?: string },
  ) => Promise<void>;
  onSignup?: (
    inviteCode: string,
    username: string,
    password: string,
    opts: { displayName: string; affiliation?: string },
  ) => Promise<{ ok: boolean; message?: string }>;
  error?: string;
}

type AuthMode = 'login' | 'signup' | 'recover';

export function LoginPage({ isSetup, onLogin, onSignup, otpChallenge, onOtpAction, emailEnrollment, onEmailEnrollmentAction, error }: LoginPageProps) {
  const { t } = useTranslation('auth');
  const [mode, setMode] = useState<AuthMode>('login');
  const [username, setUsername] = useState('');
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [enrollmentEmail,setEnrollmentEmail] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  // isSetup 또는 signup 일 때 노출: 이름은 필수, 소속은 선택.
  const [displayName, setDisplayName] = useState('');
  const [affiliation, setAffiliation] = useState('');
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [localError, setLocalError] = useState('');
  const [success, setSuccess] = useState('');

  const [now, setNow] = useState(Date.now);
  const [resending, setResending] = useState(false);
  const [resendNotice, setResendNotice] = useState('');
  useEffect(() => {
    setNow(Date.now());
    if (!otpChallenge && !emailEnrollment) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [otpChallenge?.challengeId, otpChallenge?.resendAvailableAt, emailEnrollment?.challengeId, emailEnrollment?.resendAvailableAt]);
  const resendAt = Date.parse((emailEnrollment || otpChallenge)?.resendAvailableAt || '');
  const resendSeconds = Number.isFinite(resendAt) ? Math.max(0, Math.ceil((resendAt - now) / 1000)) : 0;
  const resendOtp = async () => {
    if ((!onOtpAction && !onEmailEnrollmentAction) || loading || resending || resendSeconds > 0) return;
    setResending(true); setLoading(true); setResendNotice('');
    try {
      if (await (emailEnrollment ? onEmailEnrollmentAction?.('resend') : onOtpAction?.('resend'))) {
        setOtp('');
        setResendNotice('새 인증 코드를 발송했습니다. 가장 최근 메일의 코드를 입력하세요.');
      }
    } catch { setLocalError(t('cannotConnect')); }
    finally { setResending(false); setLoading(false); }
  };

  useEffect(() => {
    setOtp(''); setLocalError('');
    if (emailEnrollment || otpChallenge) setPassword('');
  }, [emailEnrollment?.challengeId, otpChallenge?.challengeId]);

  const [submitted, setSubmitted] = useState(false);
  const mobileKeyboardViewport = useMobileKeyboardViewport(true);

  useEffect(() => {
    if (isSetup || typeof window === 'undefined') return;
    // Shared invite-code signup is closed; ignore legacy invite URL parameters.
  }, [isSetup]);

  const isSignup = !isSetup && mode === 'signup';
  const needsProfile = isSetup || isSignup;
  const profileValid = !needsProfile || displayName.trim().length > 0;
  const inviteValid = !isSignup || inviteCode.trim().length > 0;
  const submitDisabled = loading || (mode === 'recover' && !isSetup && !emailEnrollment && !otpChallenge ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recoveryEmail.trim()) : emailEnrollment ? (emailEnrollment.emailRequired ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(enrollmentEmail.trim()) : !/^\d{6}$/.test(otp)) : otpChallenge ? !/^\d{6}$/.test(otp) : !username || !password || !profileValid || !inviteValid);

  const inputStyle = (field: string): React.CSSProperties => ({
    background: 'rgba(1, 5, 13, 0.44)',
    border: focused === field
      ? '1px solid color-mix(in srgb, var(--tower-login-accent) 64%, rgba(255,255,255,0.1))'
      : '1px solid color-mix(in srgb, var(--tower-login-secondary) 42%, rgba(255,255,255,0.1))',
    boxShadow: focused === field
      ? '0 0 0 4px color-mix(in srgb, var(--tower-login-accent) 12%, transparent), inset 0 0 24px color-mix(in srgb, var(--tower-login-secondary) 8%, transparent)'
      : 'inset 0 0 24px color-mix(in srgb, var(--tower-login-secondary) 8%, transparent)',
  });

  const labelStyle = (field: string): React.CSSProperties => ({
    color: focused === field
      ? 'color-mix(in srgb, var(--tower-login-accent) 88%, white)'
      : 'rgba(153, 246, 228, 0.84)',
  });

  const focusField = (field: string) => (event: React.FocusEvent<HTMLInputElement>) => {
    setFocused(field);
    if (window.matchMedia('(max-width: 560px)').matches) {
      window.setTimeout(() => {
        event.currentTarget.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }, 320);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setLocalError('');
    setSuccess('');
    if (mode === 'recover' && !isSetup && !emailEnrollment && !otpChallenge) {
      setLoading(true);
      try {
        await fetch('/api/auth/password-reset/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: recoveryEmail.trim() }) });
      } catch { /* Network failure uses the same public notice. */ }
      finally { setLoading(false); }
      setSuccess('해당 이메일로 복구할 수 있는 계정이라면 재설정 링크를 보냈습니다. 받은편지함과 스팸함을 확인하세요. 메일이 없다면 1분 뒤 다시 요청할 수 있습니다.');
      return;
    }
    if (emailEnrollment) {
      if (!onEmailEnrollmentAction) return;
      setLoading(true);
      try { await onEmailEnrollmentAction(emailEnrollment.emailRequired?'email':'verify',emailEnrollment.emailRequired?enrollmentEmail.trim():otp); }
      finally {setLoading(false);}
      return;
    }
    if (otpChallenge) {
      if (!/^\d{6}$/.test(otp) || !onOtpAction) return;
      setLoading(true);
      try { await onOtpAction('verify', otp); } finally { setLoading(false); }
      return;
    }
    if (!username || !password || !profileValid || !inviteValid) return;
    setLoading(true);
    try {
      if (isSignup) {
        if (!onSignup) return;
        const result = await onSignup(inviteCode.trim(), username.trim(), password, {
          displayName: displayName.trim(),
          affiliation: affiliation.trim() || undefined,
        });
        if (result.ok) {
          setSuccess(result.message || t('signupSubmitted'));
          setMode('login');
          setPassword('');
        } else {
          setLocalError(result.message || t('signupFailed'));
        }
        return;
      }
      await onLogin(
        username.trim(),
        password,
        isSetup
          ? { displayName: displayName.trim(), affiliation: affiliation.trim() || undefined }
          : undefined,
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="tower-login-shell fresh relative min-h-full"
      style={{ height: mobileKeyboardViewport.height, minHeight: mobileKeyboardViewport.height }}
    >
      <div className="tower-login-layout relative z-10 w-full">
        <section className="tower-login-hero" aria-label={t('heroAriaLabel')}>
          <div className="tower-login-mark-card" aria-hidden="true">
            <img className="tower-login-running-mark" src="/tower-running.svg" alt="" />
            <div className="tower-login-running-pill">
              <RunIndicator size="md" label="" className="tower-session-run-mark tower-login-run-indicator" />
              running
            </div>
          </div>

          <div className="tower-login-mobile-brand">
            <img src="/tower-running.svg" alt="" aria-hidden="true" />
            <span>Tower</span>
          </div>
          <p className="tower-login-eyebrow">{t('heroEyebrow')}</p>
          <h1 className="tower-login-title">
            <span className="accent">{t('heroTitleAccent')}</span>{t('heroTitleConnector')}<span className="secondary">{t('heroTitleSecondary')}</span>
          </h1>
          <p className="tower-login-subtitle">
            {t('heroSubtitlePrefix')} <strong>{t('heroSubtitleStrong')}</strong> {t('heroSubtitleSuffix')}
          </p>
          <div className="tower-login-chips" aria-hidden="true">
            <span>{t('heroChipSessions')}</span>
            <span>{t('heroChipFiles')}</span>
            <span>{t('heroChipDecisions')}</span>
            <span>{t('heroChipAgents')}</span>
          </div>
        </section>

        <div className="tower-login-card-wrap">
          <form
            onSubmit={handleSubmit}
            className="tower-login-form w-full space-y-5"
          >
            <div className="tower-login-logo" aria-hidden="true">
              <img src="/tower-running.svg" alt="" />
            </div>

            <p className="tower-login-form-kicker text-[12px] text-center font-black tracking-[0.16em] uppercase">
              {isSetup ? t('createAdminAccount') : mode === 'recover' ? '비밀번호 재설정' : isSignup ? t('requestAccess') : t('signInToContinue')}
            </p>

            {success && (
              <div
                role="status"
                className="text-base px-4 py-3 rounded-xl"
                style={{
                  color: '#86efac',
                  background: 'rgba(34, 197, 94, 0.08)',
                  border: '1px solid rgba(34, 197, 94, 0.15)',
                }}
              >
                {success}
              </div>
            )}

            {emailEnrollment && <div className="space-y-4">
              {emailEnrollment.emailRequired ? <>
                <p className="text-sm text-white">기존 계정에 사용할 이메일을 등록하세요. 메일의 확인 코드가 맞아야 로그인이 완료됩니다.</p>
                <label htmlFor="enrollment-email" className="block text-sm text-white">등록할 이메일</label>
                <input id="enrollment-email" type="email" autoComplete="email" value={enrollmentEmail}
                  onChange={e=>setEnrollmentEmail(e.target.value)} className="tower-login-input w-full rounded-xl px-4 py-3 text-base text-white" autoFocus required />
              </> : <>
                <p className="text-sm text-white">{emailEnrollment.maskedEmail}로 보낸 6자리 등록 코드를 입력하세요. 확인되면 이번 로그인이 완료됩니다. 코드는 10분간 유효하며, 만료되면 비밀번호로 다시 로그인해 새 코드를 받으세요.</p>
                <label htmlFor="enrollment-otp" className="block text-sm text-white">등록 코드</label>
                <input id="enrollment-otp" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
                  value={otp} onChange={e=>setOtp(e.target.value.replace(/\D/g,'').slice(0,6))}
                  className="tower-login-input w-full rounded-xl px-4 py-3 text-base text-white" autoFocus required />
                <div className="text-xs text-white/70">
                  <p>메일이 오지 않았나요? 스팸함도 확인해 주세요.</p>
                  <button type="button" disabled={loading || resending || resendSeconds>0} aria-busy={resending}
                    className="min-h-11 text-xs underline underline-offset-4 disabled:no-underline disabled:cursor-default"
                    onClick={()=>void resendOtp()}>{resending?'재발송 중…':resendSeconds>0?'재발송은 발송 후 1분부터 가능합니다':'인증 코드 다시 받기'}</button>
                </div>
              </>}
              <button type="button" disabled={loading} onClick={()=>{setOtp('');setPassword('');void onEmailEnrollmentAction?.('cancel');}}>로그인으로 돌아가기</button>
            </div>}
            {emailEnrollment && resendNotice && <p role="status" className="text-sm text-white">{resendNotice}</p>}
            {otpChallenge && (
              <div className="space-y-4">
                <p className="text-sm text-white">이메일 {otpChallenge.maskedEmail}로 보낸 6자리 인증 코드를 입력하세요. 코드는 발송 후 10분간 유효합니다.</p>
                <label htmlFor="login-otp" className="block text-sm text-white">인증 코드</label>
                <input id="login-otp" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
                  value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="tower-login-input w-full rounded-xl px-4 py-3 text-base text-white" style={inputStyle('otp')} autoFocus required />
                <div className="text-xs text-white/70">
                  <p>메일이 오지 않았나요? 스팸함도 확인해 주세요.</p>
                  <button type="button" disabled={loading || resending || resendSeconds > 0 || !onOtpAction} aria-busy={resending} className="min-h-11 text-xs underline underline-offset-4 disabled:no-underline disabled:cursor-default" onClick={() => void resendOtp()}>{resending ? '재발송 중…' : resendSeconds > 0 ? '재발송은 발송 후 1분부터 가능합니다' : '인증 코드 다시 받기'}</button>
                </div>
                <div className="text-sm">
                  <button type="button" disabled={loading} onClick={() => { setOtp(''); setPassword(''); void onOtpAction?.('cancel'); }}>로그인으로 돌아가기</button>
                </div>
              </div>
            )}

            {otpChallenge && resendNotice && <p role="status" className="text-sm text-white">{resendNotice}</p>}

            {!isSetup && mode === 'recover' && !otpChallenge && !emailEnrollment && <div>
              <label htmlFor="recovery-email" className="block text-sm mb-2 font-medium text-white">확인된 계정 이메일</label>
              <input id="recovery-email" type="email" autoComplete="email" value={recoveryEmail} onChange={event => setRecoveryEmail(event.target.value)} required className="tower-login-input w-full rounded-xl px-4 py-3 text-base text-white" style={inputStyle('recovery-email')} />
              <p className="mt-2 text-xs text-white/70">일반 계정의 확인된 이메일로만 재설정 링크가 발송됩니다. 관리자·운영자 계정은 관리자에게 문의하세요.</p>
            </div>}
            {!otpChallenge && !emailEnrollment && isSignup && (
              <div>
                <label
                  htmlFor="signup-invite-code"
                  className="block text-sm mb-2 font-medium transition-colors duration-200"
                  style={labelStyle('inviteCode')}
                >
                  {t('inviteCode')}
                </label>
                <input
                  id="signup-invite-code"
                  type="text"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  onFocus={focusField('inviteCode')}
                  onBlur={() => setFocused(null)}
                  className="tower-login-input w-full rounded-xl px-4 py-3 text-base text-white transition-all duration-300 outline-none"
                  style={inputStyle('inviteCode')}
                  autoFocus
                  autoComplete="off"
                  required
                  aria-invalid={submitted && !inviteCode.trim()}
                />
                {submitted && !inviteCode.trim() && (
                  <p className="text-[13px] mt-1.5" style={{ color: '#f87171' }}>
                    {t('inviteCodeRequired')}
                  </p>
                )}
              </div>
            )}

            {!otpChallenge && !emailEnrollment && mode !== 'recover' && <div>
              <label
                htmlFor="login-username"
                className="block text-sm mb-2 font-medium transition-colors duration-200"
                style={labelStyle('username')}
              >
                {isSetup || isSignup ? t('username') : t('loginIdentifier', { defaultValue: '로그인 ID 또는 확인된 이메일' })}
              </label>
              <input
                id="login-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onFocus={focusField('username')}
                onBlur={() => setFocused(null)}
                className="tower-login-input w-full rounded-xl px-4 py-3 text-base text-white transition-all duration-300 outline-none [&:-webkit-autofill]:[-webkit-text-fill-color:white] [&:-webkit-autofill]:[transition:background-color_9999s]"
                style={inputStyle('username')}
                autoFocus={!isSignup}
                autoComplete="username"
                required
                aria-invalid={submitted && !username}
              />
              {submitted && !username && (
                <p className="text-[13px] mt-1.5" style={{ color: '#f87171' }}>
                  {t('usernameRequired')}
                </p>
              )}
            </div>}

            {!otpChallenge && !emailEnrollment && mode !== 'recover' && <div>
              <label
                htmlFor="login-password"
                className="block text-sm mb-2 font-medium transition-colors duration-200"
                style={labelStyle('password')}
              >
                {t('password')}
              </label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onFocus={focusField('password')}
                onBlur={() => setFocused(null)}
                className="tower-login-input w-full rounded-xl px-4 py-3 text-base text-white transition-all duration-300 outline-none [&:-webkit-autofill]:[-webkit-text-fill-color:white] [&:-webkit-autofill]:[transition:background-color_9999s]"
                style={inputStyle('password')}
                autoComplete={needsProfile ? 'new-password' : 'current-password'}
                required
                aria-invalid={submitted && !password}
              />
              {submitted && !password && (
                <p className="text-[13px] mt-1.5" style={{ color: '#f87171' }}>
                  {t('passwordRequired')}
                </p>
              )}
            </div>}

            {!otpChallenge && !emailEnrollment && needsProfile && (
              <>
                <div>
                  <label
                    htmlFor="login-display-name"
                    className="block text-sm mb-2 font-medium transition-colors duration-200"
                    style={labelStyle('displayName')}
                  >
                    {t('displayName')}
                  </label>
                  <input
                    id="login-display-name"
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    onFocus={focusField('displayName')}
                    onBlur={() => setFocused(null)}
                    placeholder={t('displayNamePlaceholder')}
                    className="tower-login-input w-full rounded-xl px-4 py-3 text-base text-white transition-all duration-300 outline-none"
                    style={inputStyle('displayName')}
                    required
                    aria-invalid={submitted && !displayName.trim()}
                  />
                  {submitted && !displayName.trim() && (
                    <p className="text-[13px] mt-1.5" style={{ color: '#f87171' }}>
                      {t('displayNameRequired')}
                    </p>
                  )}
                </div>

                <div>
                  <label
                    htmlFor="login-affiliation"
                    className="block text-sm mb-2 font-medium transition-colors duration-200"
                    style={labelStyle('affiliation')}
                  >
                    {t('affiliation')}
                  </label>
                  <input
                    id="login-affiliation"
                    type="text"
                    value={affiliation}
                    onChange={(e) => setAffiliation(e.target.value)}
                    onFocus={focusField('affiliation')}
                    onBlur={() => setFocused(null)}
                    placeholder={t('affiliationPlaceholder')}
                    className="tower-login-input w-full rounded-xl px-4 py-3 text-base text-white transition-all duration-300 outline-none"
                    style={inputStyle('affiliation')}
                  />
                </div>
              </>
            )}

            {(error || localError) && (
              <div
                role="alert"
                className="text-base px-4 py-3 rounded-xl"
                style={{
                  color: '#f87171',
                  background: 'rgba(239, 68, 68, 0.08)',
                  border: '1px solid rgba(239, 68, 68, 0.15)',
                }}
              >
                {localError || error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitDisabled}
              className="tower-login-submit w-full py-3 rounded-xl text-base font-bold tracking-wide transition-all duration-300 cursor-pointer disabled:cursor-not-allowed"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity="0.3" />
                    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                  {t('common:processing')}
                </span>
              ) : emailEnrollment ? (emailEnrollment.emailRequired ? '등록 코드 보내기' : '이메일 확인하고 로그인') : otpChallenge ? '인증하고 로그인' : mode === 'recover' ? '재설정 링크 요청' : isSetup ? t('createAccount') : isSignup ? t('submitSignup') : t('signIn')}
            </button>


          </form>
          {!isSetup && !otpChallenge && !emailEnrollment && <button type="button" className="mt-4 min-h-11 w-full text-sm text-white/80 underline underline-offset-4" onClick={() => { setLocalError(''); setSuccess(''); setMode(mode === 'recover' ? 'login' : 'recover'); }}>{mode === 'recover' ? '로그인으로 돌아가기' : '비밀번호를 잊으셨나요?'}</button>}

          <p className="tower-login-footer text-center text-[13px] mt-8 font-medium tracking-wider">
            {t('poweredBy')}
          </p>
        </div>
      </div>
    </div>
  );
}
