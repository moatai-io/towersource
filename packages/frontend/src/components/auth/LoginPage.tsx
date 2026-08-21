import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RunIndicator } from '../common/RunIndicator';

interface LoginPageProps {
  isSetup: boolean;
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

type AuthMode = 'login' | 'signup';

export function LoginPage({ isSetup, onLogin, onSignup, error }: LoginPageProps) {
  const { t } = useTranslation('auth');
  const [mode, setMode] = useState<AuthMode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  // isSetup 또는 signup 일 때 노출: 이름은 필수, 소속은 선택.
  const [displayName, setDisplayName] = useState('');
  const [affiliation, setAffiliation] = useState('');
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [localError, setLocalError] = useState('');
  const [success, setSuccess] = useState('');

  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (isSetup || typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('invite') || params.get('inviteCode') || params.get('code');
    if (!code) return;
    setMode('signup');
    setInviteCode(code.trim());
  }, [isSetup]);

  const isSignup = !isSetup && mode === 'signup';
  const needsProfile = isSetup || isSignup;
  const profileValid = !needsProfile || displayName.trim().length > 0;
  const inviteValid = !isSignup || inviteCode.trim().length > 0;
  const submitDisabled = loading || !username || !password || !profileValid || !inviteValid;

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
    <div className="tower-login-shell fresh relative min-h-full">
      <div className="tower-login-layout relative z-10 w-full">
        <section className="tower-login-hero" aria-label={t('heroAriaLabel')}>
          <div className="tower-login-mark-card" aria-hidden="true">
            <img className="tower-login-running-mark" src="/tower-running.svg" alt="" />
            <div className="tower-login-running-pill">
              <RunIndicator size="md" label="" className="tower-session-run-mark tower-login-run-indicator" />
              running
            </div>
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
              {isSetup ? t('createAdminAccount') : isSignup ? t('requestAccess') : t('signInToContinue')}
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

            {isSignup && (
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

            <div>
              <label
                htmlFor="login-username"
                className="block text-sm mb-2 font-medium transition-colors duration-200"
                style={labelStyle('username')}
              >
                {t('username')}
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
            </div>

            <div>
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
            </div>

            {needsProfile && (
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
              ) : isSetup ? t('createAccount') : isSignup ? t('submitSignup') : t('signIn')}
            </button>

            {!isSetup && onSignup && (
              <button
                type="button"
                onClick={() => {
                  setMode(isSignup ? 'login' : 'signup');
                  setSubmitted(false);
                  setLocalError('');
                  setSuccess('');
                }}
                className="tower-login-switch w-full text-[14px] font-medium transition-colors"
              >
                {isSignup ? t('backToLogin') : t('signupWithInvite')}
              </button>
            )}
          </form>

          <p className="tower-login-footer text-center text-[13px] mt-8 font-medium tracking-wider">
            {t('poweredBy')}
          </p>
        </div>
      </div>
    </div>
  );
}
