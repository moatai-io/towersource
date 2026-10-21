import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '../../hooks/useDialog';
import { getCurrentRole } from '../../utils/auth';
import { EmailInvitationManagement } from './EmailInvitationManagement';

const API_BASE = '/api';

interface User {
  id: number;
  username: string;
  role: string;
  approval_status?: 'active' | 'pending' | 'rejected' | 'suspended';
  disabled: boolean;
  last_login_at?: string | null;
  last_login_ip?: string | null;
  display_name: string | null;
  affiliation: string | null;
  account_email?: string | null;
  account_email_status?: 'verified' | 'pending' | 'missing';
  signup_invite_code?: string | null;
  signup_invite_label?: string | null;
  projects?: Array<{ id: string; name: string; role?: string }>;
  created_at: string;
}

interface SignupInviteCode {
  id: number;
  code: string;
  label: string | null;
  default_role: string;
  max_uses: number | null;
  used_count: number;
  expires_at: string | null;
  disabled: boolean;
  signup_count?: number;
  pending_count?: number;
  active_count?: number;
}

type SignupApprovalMode = 'auto' | 'manual';

interface SignupSettings {
  approvalMode: SignupApprovalMode;
}

const emptyNewUser = () => ({
  username: '',
  password: '',
  passwordConfirm: '',
  role: 'member',
  displayName: '',
  affiliation: '',
  email: '',
});

export function UserManagement({ token }: { token?: string | null }) {
  const { t } = useTranslation('admin');
  const confirm = useConfirm();
  // role 은 모달이 admin only 인 username 편집을 가드하기 위해 필요. JWT 가 single source.
  const role = getCurrentRole() || 'member';
  const [users, setUsers] = useState<User[]>([]);
  // Render one interactive surface at a time; CSS-hidden controls still collide with selectors and focus.
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 1023px)').matches);
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1023px)');
    const update = () => setCompact(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all'|'active'|'disabled'|'pending'|'email-missing'|'email-pending'>('all');
  const [selected, setSelected] = useState<number | null>(null);
  const [compactReturnId, setCompactReturnId] = useState<number | null>(null);
  const [events, setEvents] = useState<Array<{id:number;event_type:string;ip_address:string|null;created_at:string}>>([]);
  const [eventsError, setEventsError] = useState('');
  const [eventCursor, setEventCursor] = useState<number | null>(null);
  const [emailTarget, setEmailTarget] = useState<number | null>(null);
  const [emailInput, setEmailInput] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailFeedback, setEmailFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [invites, setInvites] = useState<SignupInviteCode[]>([]);
  const [signupSettings, setSignupSettings] = useState<SignupSettings>({ approvalMode: 'auto' });
  const [showInvites, setShowInvites] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newUser, setNewUser] = useState(emptyNewUser);
  const [resetPwUserId, setResetPwUserId] = useState<number | null>(null);
  const [resetPwValue, setResetPwValue] = useState('');
  const [resetPwConfirm, setResetPwConfirm] = useState('');
  const [resetPwError, setResetPwError] = useState('');
  const [error, setError] = useState('');
  // EditUserModal 대상. null 이면 모달 닫힘.
  const [editTarget, setEditTarget] = useState<User | null>(null);
  const editReturnRef = useRef<HTMLButtonElement>(null);
  const closeEdit = () => {
    setEditTarget(null);
    requestAnimationFrame(() => editReturnRef.current?.focus());
  };

  const headers = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }, [token]);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const usersRes = await fetch(`${API_BASE}/admin/users`, { headers: headers() });
      if (!usersRes.ok) throw new Error(t('userListLoadFailed'));
      setUsers(await usersRes.json());
      if (role === 'admin') {
        const invitesRes = await fetch(`${API_BASE}/admin/signup-invites`, { headers: headers() });
        if (invitesRes.ok) setInvites(await invitesRes.json());
        const settingsRes = await fetch(`${API_BASE}/admin/signup-settings`, { headers: headers() });
        if (settingsRes.ok) setSignupSettings(await settingsRes.json());
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('userListLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [headers, role, t]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const emailRequest = async (path: string, method: 'POST' | 'DELETE', body?: object) => {
    setEmailFeedback(null); setEmailBusy(true);
    try {
      const res = await fetch(`${API_BASE}${path}`, { method, headers: headers(), ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '이메일 요청에 실패했습니다.');
      }
      setEmailTarget(null); setEmailInput('');
      setEmailFeedback({ ok: true, text: method === 'DELETE' ? '이메일 인증 대기를 취소했습니다.' : '확인 메일 발송 요청이 완료됐습니다. 받은편지함을 확인해 주세요.' });
      await fetchUsers();
    } catch (err) {
      setEmailFeedback({ ok: false, text: err instanceof Error ? err.message : '이메일 요청에 실패했습니다.' });
    } finally { setEmailBusy(false); }
  };

  const sendPasswordResetEmail = async (user: User) => {
    const approved = await confirm({ title: '비밀번호 재설정 메일 보내기', message: `${user.account_email} 주소로 일회용 재설정 링크를 보냅니다. 사용자가 직접 새 비밀번호를 정합니다.`, confirmLabel: '메일 보내기', danger: false });
    if (!approved) return;
    setEmailBusy(true); setEmailFeedback(null);
    try {
      const response = await fetch(`${API_BASE}/admin/users/${user.id}/password-reset-email`, { method: 'POST', headers: headers() });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || '재설정 메일 발송에 실패했습니다.');
      }
      setEmailFeedback({ ok: true, text: '메일 서비스가 재설정 메일 발송을 접수했습니다. 받은편지함과 스팸함을 확인해 주세요.' });
    } catch (error) {
      setEmailFeedback({ ok: false, text: error instanceof Error ? error.message : '재설정 메일 발송에 실패했습니다.' });
    } finally { setEmailBusy(false); }
  };

  const currentUsername = (() => {
    try {
      const t = token?.split('.')[1];
      if (t) return JSON.parse(atob(t)).username;
    } catch {}
    return '';
  })();

  const handleCreate = async () => {
    setError('');
    if (!newUser.username || !newUser.password) { setError(t('usernameAndPasswordRequired')); return; }
    if (newUser.password.length < 8) { setError(t('passwordMin8Chars')); return; }
    if (newUser.password !== newUser.passwordConfirm) { setError(t('passwordsDoNotMatch')); return; }
    if (!newUser.displayName.trim()) { setError(t('displayNameRequired')); return; }
    if (!newUser.email.trim()) { setError('계정 이메일을 입력하세요.'); return; }
    try {
      const { passwordConfirm, displayName, affiliation, email, ...rest } = newUser;
      const payload = {
        ...rest,
        displayName: displayName.trim(),
        affiliation: affiliation.trim() || null,
        email: email.trim(),
        passwordConfirm,
      };
      const res = await fetch(`${API_BASE}/admin/users`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setShowForm(false);
        setNewUser(emptyNewUser());
        fetchUsers();
      } else {
        const data = await res.json();
        setError(data.error || t('creationFailed'));
      }
    } catch { setError(t('serverError')); }
  };

  const toggleCreateForm = () => {
    setNewUser(emptyNewUser());
    setError('');
    setShowForm((visible) => !visible);
  };

  const closeCreateForm = () => {
    setShowForm(false);
    setNewUser(emptyNewUser());
    setError('');
  };

  const handleRoleChange = async (userId: number, role: string) => {
    const res = await fetch(`${API_BASE}/admin/users/${userId}`, {
      method: 'PATCH', headers: headers(),
      body: JSON.stringify({ role }),
    });
    if (!res.ok) { setError((await res.json().catch(() => ({}))).error || t('roleChangeFailed')); return; }
    await fetchUsers();
  };

  const fetchInvites = useCallback(async () => {
    if (role !== 'admin') return;
    const [invitesRes, settingsRes] = await Promise.all([
      fetch(`${API_BASE}/admin/signup-invites`, { headers: headers() }),
      fetch(`${API_BASE}/admin/signup-settings`, { headers: headers() }),
    ]);
    if (invitesRes.ok) setInvites(await invitesRes.json());
    if (settingsRes.ok) setSignupSettings(await settingsRes.json());
  }, [headers, role]);

  const handleSignupApprovalModeChange = async (approvalMode: SignupApprovalMode) => {
    setSignupSettings({ approvalMode });
    const res = await fetch(`${API_BASE}/admin/signup-settings`, {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ approvalMode }),
    });
    if (res.ok) setSignupSettings(await res.json());
  };

  const handleApproveUser = async (userId: number) => {
    const res = await fetch(`${API_BASE}/admin/users/${userId}/approve`, { method: 'POST', headers: headers() });
    if (!res.ok) { setError((await res.json().catch(() => ({}))).error || t('approvalFailed')); return; }
    await fetchUsers();
  };

  const handleRejectUser = async (userId: number) => {
    const res = await fetch(`${API_BASE}/admin/users/${userId}/reject`, {
      method: 'POST', headers: headers(), body: JSON.stringify({}),
    });
    if (!res.ok) { setError((await res.json().catch(() => ({}))).error || t('rejectionFailed')); return; }
    await fetchUsers();
  };

  /**
   * 이름·소속 inline 편집. value === '' 면 null 로 보내서 NULL 저장.
   */
  const handleProfileChange = async (
    userId: number,
    fields: { displayName?: string; affiliation?: string },
  ) => {
    const payload: any = {};
    if (fields.displayName !== undefined) payload.displayName = fields.displayName === '' ? null : fields.displayName;
    if (fields.affiliation !== undefined) payload.affiliation = fields.affiliation === '' ? null : fields.affiliation;
    await fetch(`${API_BASE}/admin/users/${userId}`, {
      method: 'PATCH', headers: headers(),
      body: JSON.stringify(payload),
    });
    fetchUsers();
  };

  /**
   * username 변경 — 영향 안내 모달 후 실행. 대상 사용자는 모든 기기에서 자동 로그아웃.
   * 권한·세션·작업물은 그대로 유지.
   */
  const handleUsernameChange = async (u: User, newUsername: string) => {
    const trimmed = newUsername.trim();
    if (!trimmed || trimmed === u.username) return;
    const ok = await confirm({
      title: t('renameUserTitle'),
      message: t('renameUserConfirm', { old: u.username, new: trimmed }),
      confirmLabel: t('rename'),
      danger: false,
    });
    if (!ok) return;
    const res = await fetch(`${API_BASE}/admin/users/${u.id}`, {
      method: 'PATCH', headers: headers(),
      body: JSON.stringify({ username: trimmed }),
    });
    if (res.ok) {
      fetchUsers();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || t('renameFailed'));
    }
  };

  const handleResetPassword = async (userId: number) => {
    setResetPwError('');
    if (!resetPwValue) return;
    if (resetPwValue.length < 8) { setResetPwError(t('minChars')); return; }
    if (resetPwValue !== resetPwConfirm) { setResetPwError(t('passwordsDoNotMatch')); return; }
    const res = await fetch(`${API_BASE}/admin/users/${userId}/password`, {
      method: 'PATCH', headers: headers(),
      body: JSON.stringify({ password: resetPwValue }),
    });
    if (res.ok) {
      setResetPwUserId(null);
      setResetPwValue('');
      setResetPwConfirm('');
      setResetPwError('');
    } else {
      const data = await res.json();
      setResetPwError(data.error || t('resetFailed'));
    }
  };

  const fetchEvents = async (userId: number, before?: number) => {
    setEventsError('');
    try {
      const res = await fetch(`${API_BASE}/admin/users/${userId}/auth-events${before ? `?before=${before}` : ''}`, { headers: headers() });
      if (!res.ok) throw new Error(t('activityLoadFailed'));
      const page = await res.json() as typeof events;
      if (selected !== userId) return;
      setEvents(before ? previous => [...previous, ...page] : page);
      setEventCursor(page.length === 20 ? page[page.length - 1].id : null);
    } catch (error) { setEventsError(error instanceof Error ? error.message : t('activityLoadFailed')); }
  };

  const handleReactivate = async (u: User) => {
    const ok = await confirm({ title: t('reactivateUser'), message: t('reactivateConfirm', { username: u.username }), confirmLabel: t('reactivateUser') });
    if (!ok) return;
    const res = await fetch(`${API_BASE}/admin/users/${u.id}/reactivate`, { method: 'POST', headers: headers() });
    if (!res.ok) { setError((await res.json().catch(() => ({}))).error || t('reactivateFailed')); return; }
    await fetchUsers();
  };

  const handleDelete = async (userId: number, username: string) => {
    const ok = await confirm({
      title: t('disableUser', { defaultValue: 'Disable user' }),
      message: t('disableUserConfirm', { username }),
      confirmLabel: t('disable', { defaultValue: 'Disable' }),
      danger: true,
    });
    if (!ok) return;
    const res = await fetch(`${API_BASE}/admin/users/${userId}`, { method: 'DELETE', headers: headers() });
    if (!res.ok) { setError((await res.json().catch(() => ({}))).error || t('disableFailed')); return; }
    await fetchUsers();
  };

  const visibleUsers = users.filter(u => {
    const q = search.trim().toLocaleLowerCase();
    if (q && ![u.username, u.display_name, u.affiliation, u.account_email].some(value => value?.toLocaleLowerCase().includes(q))) return false;
    if (filter === 'active') return !u.disabled && u.approval_status === 'active';
    if (filter === 'disabled') return u.disabled;
    if (filter === 'pending') return !u.disabled && u.approval_status === 'pending';
    if (filter === 'email-missing') return u.account_email_status === 'missing';
    if (filter === 'email-pending') return u.account_email_status === 'pending';
    return true;
  });

  const primaryUsers = visibleUsers.filter(u => !u.disabled);
  const disabledUsers = visibleUsers.filter(u => u.disabled);
  // Search opens matching disabled accounts; explicit disabled filter opens the section too.
  const [disabledExpanded, setDisabledExpanded] = useState(false);
  const showDisabled = filter === 'disabled' || Boolean(search.trim()) || disabledExpanded;
  const listedUsers = filter === 'disabled' ? disabledUsers : [...primaryUsers, ...(showDisabled ? disabledUsers : [])];
  const compactUser = compact ? listedUsers.find(u => u.id === selected) : undefined;
  useEffect(() => {
    if (compact && compactUser) detailRef.current?.focus();
    else if (compact && selected === null && compactReturnId !== null) {
      document.querySelector<HTMLButtonElement>(`[data-compact-user-id="${compactReturnId}"]`)?.focus();
      setCompactReturnId(null);
    }
  }, [compact, compactUser?.id, compactReturnId, selected]);

  if (loading) {
    return <div className="text-base text-gray-500 py-8 text-center">{t('common:loading')}</div>;
  }

  return (
    <div className="space-y-4">
      {emailFeedback && <div role={emailFeedback.ok ? 'status' : 'alert'} className={`rounded-lg border px-4 py-3 text-sm ${emailFeedback.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-red-500/30 bg-red-500/10 text-red-300'}`}>{emailFeedback.text}</div>}
      {error && !showForm && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-[14px] text-red-300">
          <span>{error}</span>
          <button onClick={() => void fetchUsers()} className="rounded-md border border-red-400/30 px-3 py-1.5 font-medium hover:bg-red-500/10">
            {t('retryUserList')}
          </button>
        </div>
      )}
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[15px] text-gray-400">
          {t('registeredUsers', { count: users.length })}
        </p>
        <button
          onClick={toggleCreateForm}
          className="min-h-11 text-[14px] px-3 py-1.5 rounded-lg bg-primary-600/20 border border-primary-500/30 text-primary-300 hover:bg-primary-600/30 transition-colors font-medium"
        >
          {showForm ? t('common:cancel') : '계정 직접 생성'}
        </button>
      </div>

      <div className="hidden rounded-lg border border-surface-700 bg-surface-800/25 px-4 py-3 lg:block">
        <div className="text-[14px] font-semibold text-gray-300">{t('userOnboardingTitle')}</div>
        <div className="mt-1 text-[13px] text-gray-500 leading-relaxed">
          {t('userOnboardingIntro')}
        </div>
        <div className="mt-2 grid gap-2 text-[13px] sm:grid-cols-3">
          <div className="rounded-md bg-surface-900/60 border border-surface-800 px-3 py-2">
            <div className="text-gray-300 font-medium">1. {t('onboardingIdentity')}</div>
            <div className="text-gray-600 mt-0.5">{t('onboardingIdentityDesc')}</div>
          </div>
          <div className="rounded-md bg-surface-900/60 border border-surface-800 px-3 py-2">
            <div className="text-gray-300 font-medium">2. {t('onboardingRole')}</div>
            <div className="text-gray-600 mt-0.5">{t('onboardingRoleDesc')}</div>
          </div>
          <div className="rounded-md bg-surface-900/60 border border-surface-800 px-3 py-2">
            <div className="text-gray-300 font-medium">3. {t('onboardingProjectInvite')}</div>
            <div className="text-gray-600 mt-0.5">{t('onboardingProjectInviteDesc')}</div>
          </div>
        </div>
      </div>

      <details className="rounded-lg border border-surface-700 px-4 py-2 lg:hidden">
        <summary className="min-h-11 cursor-pointer py-3 text-sm text-surface-300">{t('userOnboardingTitle')}</summary>
        <p className="pb-3 text-sm text-surface-400">{t('userOnboardingIntro')}</p>
      </details>

      <EmailInvitationManagement token={token} roles={role === 'admin' ? ['member', 'operator', 'admin'] : ['member']} />

      {/* Create form: optional administrator-managed provisioning */}
      {showForm && (
        <div className="p-4 bg-surface-800/40 rounded-lg border border-surface-700 space-y-3">
          {error && <div className="text-[14px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">{error}</div>}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="create-user-displayName" className="block text-[13px] text-gray-500 mb-1">{t('userDisplayName')}</label>
              <input
                type="text"
                id="create-user-displayName" value={newUser.displayName}
                onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })}
                className="w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[15px] text-gray-200 focus:outline-none focus:border-primary-500/50"
                placeholder={t('userDisplayNamePlaceholder')}
              />
            </div>
            <div>
              <label htmlFor="create-user-affiliation" className="block text-[13px] text-gray-500 mb-1">{t('userAffiliation')}</label>
              <input
                type="text"
                id="create-user-affiliation" value={newUser.affiliation}
                onChange={(e) => setNewUser({ ...newUser, affiliation: e.target.value })}
                className="w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[15px] text-gray-200 focus:outline-none focus:border-primary-500/50"
                placeholder={t('userAffiliationPlaceholder')}
              />
            </div>
            <div>
              <label htmlFor="create-user-email" className="block text-[13px] text-gray-500 mb-1">계정 이메일</label>
              <input type="email" aria-label="새 사용자 계정 이메일" id="create-user-email" value={newUser.email}
                onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                className="w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[15px] text-gray-200 focus:outline-none focus:border-primary-500/50"
                placeholder="name@example.com" />
              <p className="mt-1 text-[12px] text-gray-500">확인 메일을 발송하며, 확인 전에는 계정이 활성화되지 않습니다.</p>
            </div>
            <div>
              <label htmlFor="create-user-username" className="block text-[13px] text-gray-500 mb-1">{t('username')}</label>
              <input
                type="text"
                id="create-user-username" value={newUser.username}
                name="tower-create-user-id"
                autoComplete="new-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                className="w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[15px] text-gray-200 focus:outline-none focus:border-primary-500/50"
                placeholder={t('usernamePlaceholder')}
              />
            </div>
            <div>
              <label htmlFor="create-user-password" className="block text-[13px] text-gray-500 mb-1">{t('password')}</label>
              <input
                type="password"
                id="create-user-password" value={newUser.password}
                name="tower-create-user-password"
                onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                className="min-h-11 w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[15px] text-gray-200 font-mono focus:outline-none focus:border-primary-500/50"
                placeholder={t('passwordHint')}
                autoComplete="new-password"
              />
            </div>
            <div>
              <label htmlFor="create-user-passwordConfirm" className="block text-[13px] text-gray-500 mb-1">{t('confirmPassword')}</label>
              <input
                type="password"
                id="create-user-passwordConfirm" value={newUser.passwordConfirm}
                name="tower-create-user-password-confirm"
                autoComplete="new-password"
                onChange={(e) => setNewUser({ ...newUser, passwordConfirm: e.target.value })}
                className={`w-full bg-surface-900 border rounded-md px-3 py-2 text-[15px] text-gray-200 font-mono focus:outline-none focus:border-primary-500/50 ${
                  newUser.passwordConfirm && newUser.password !== newUser.passwordConfirm ? 'border-red-500/50' : 'border-surface-700'
                }`}
                placeholder={t('confirmPasswordHint')}
              />
            </div>
            <div>
              <label htmlFor="create-user-role" className="block text-[13px] text-gray-500 mb-1">{t('role')}</label>
              <select
                id="create-user-role" value={newUser.role}
                onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                className="w-full bg-surface-900 border border-surface-700 text-gray-300 rounded-md px-3 py-2 text-[15px]"
              >
                <option value="viewer">{t('roleViewer')}</option>
                <option value="guest">{t('roleGuest')}</option>
                <option value="member">{t('roleMember')}</option>
                {role === 'admin' && <option value="operator">{t('roleOperator')}</option>}
                {role === 'admin' && <option value="admin">{t('roleAdmin')}</option>}
              </select>
            </div>
            <div className="rounded-md border border-surface-700 bg-surface-900/50 px-3 py-2">
              <div className="text-[13px] text-gray-500 mb-1">{t('accessScope')}</div>
              <div className="text-[14px] text-gray-300">{t('accessDerivedFromRoleAndProjects')}</div>
              <p className="mt-1 text-[12px] text-gray-600 leading-snug">
                {t('accessDerivedHint')}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <button
              onClick={closeCreateForm}
              className="min-h-11 px-4 py-2 text-[14px] text-gray-400 hover:text-gray-200 transition-colors rounded-md"
            >
              {t('common:cancel')}
            </button>
            <button
              onClick={handleCreate}
              className="min-h-11 px-4 py-2 text-[14px] bg-primary-600 hover:bg-primary-500 text-white rounded-md transition-colors font-medium"
            >
              {t('common:create')}
            </button>
          </div>
        </div>
      )}

      {role === 'admin' && compact && <button type="button" aria-expanded={showInvites} onClick={() => setShowInvites(value => !value)} className="min-h-11 w-full rounded-lg border border-surface-700 px-4 text-left text-sm text-surface-300">{t('inviteCode')} {showInvites ? '−' : '+'}</button>}
      {role === 'admin' && (!compact || showInvites) && (
        <SignupInviteCodesPanel
          token={token}
          invites={invites}
          settings={signupSettings}
          onApprovalModeChange={handleSignupApprovalModeChange}
          onRefresh={fetchInvites}
        />
      )}

      <div className="flex flex-col items-stretch gap-2 border-y border-surface-700 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        <label className="sr-only" htmlFor="user-search">{t('searchUsers')}</label>
        <input id="user-search" type="search" value={search} onChange={e => { setSearch(e.target.value); setCompactReturnId(null); setSelected(null); }} placeholder={t('searchUsers')}
          className="min-h-11 min-w-0 w-full flex-1 rounded-md border border-surface-700 bg-surface-900 px-3 text-sm text-surface-100 sm:max-w-xs" />
        <label className="sr-only" htmlFor="user-filter">{t('filterUsers')}</label>
        <select id="user-filter" value={filter} onChange={e => { setFilter(e.target.value as typeof filter); setCompactReturnId(null); setSelected(null); }}
          className="min-h-11 w-full rounded-md border border-surface-700 bg-surface-900 px-3 text-sm text-surface-100 sm:w-auto">
          {(['all','active','disabled','pending','email-missing','email-pending'] as const).map(value => <option key={value} value={value}>{t(`userFilter.${value}`)}</option>)}
        </select>
        <span aria-live="polite" className="text-xs text-surface-400">{t('shownUsers', { count: listedUsers.length })}</span>
      </div>

      {filter !== 'disabled' && !search.trim() && disabledUsers.length > 0 && <button type="button" aria-expanded={showDisabled} onClick={() => { setSelected(null); setDisabledExpanded(value => !value); }} className="min-h-11 w-full rounded-lg border border-surface-700 px-4 py-2 text-left text-sm text-surface-300 hover:bg-surface-800/40">
        비활성 계정 {disabledUsers.length}명 · {showDisabled ? '접기' : '펼치기'}
      </button>}
      {filter === 'disabled' && <p className="text-sm text-surface-400">비활성 계정만 표시합니다. 승인 대기·거절 계정은 자동 승인되지 않습니다.</p>}
      {search.trim() && filter !== 'disabled' && disabledUsers.length > 0 && <p className="text-xs text-surface-400">검색 결과의 비활성 계정 {disabledUsers.length}명도 함께 표시합니다.</p>}

      {compact && (
        <div className="space-y-3 lg:hidden">
          {compactUser ? (
            <section ref={detailRef} tabIndex={-1} aria-label={t('userDetails')} className="min-w-0 space-y-5 rounded-lg border border-surface-700 bg-surface-800/20 p-4 outline-none focus-visible:ring-2 focus-visible:ring-primary-400">
              <button type="button" onClick={() => { setCompactReturnId(compactUser.id); setSelected(null); setEmailTarget(null); setResetPwUserId(null); }} className="min-h-11 rounded-md px-2 text-sm text-primary-300 focus-visible:ring-2 focus-visible:ring-primary-400">← {t('backToUsers')}</button>
              <div className="min-w-0 border-b border-surface-700 pb-4">
                <h3 className="break-words text-lg font-semibold text-surface-100">{compactUser.display_name || compactUser.username}</h3>
                <p className="break-all font-mono text-sm text-surface-400">@{compactUser.username} · ID {compactUser.id}</p>
                {compactUser.affiliation && <p className="break-words text-sm text-surface-400">{compactUser.affiliation}</p>}
              </div>
              <div className="grid min-w-0 gap-4">
                <div className="space-y-2">
                  <h4 className="text-sm font-semibold text-surface-200">{t('userStatus')}</h4>
                  <ApprovalStatusCell user={compactUser} isAdmin={role === 'admin'} onApprove={() => void handleApproveUser(compactUser.id)} onReject={() => void handleRejectUser(compactUser.id)} compact />
                </div>
                <div className="space-y-2 border-t border-surface-700 pt-4">
                  <h4 className="text-sm font-semibold text-surface-200">{t('accountEmail')}</h4>
                  <p className="break-all text-sm text-surface-300">{compactUser.account_email || t('accountEmailMissing')}</p>
                  {compactUser.account_email && <p className="text-xs text-surface-400">{compactUser.account_email_status === 'verified' ? t('accountEmailVerified') : t('accountEmailPending')}</p>}
                  {(role === 'admin' || !['admin', 'operator'].includes(compactUser.role)) && (emailTarget === compactUser.id ? (
                    <div className="space-y-2">
                      <label htmlFor="compact-account-email" className="block text-sm text-surface-300">{t('accountEmail')}</label>
                      <input id="compact-account-email" type="email" value={emailInput} onChange={e => setEmailInput(e.target.value)} placeholder="name@example.com" className="min-h-11 w-full min-w-0 rounded-md border border-surface-700 bg-surface-900 px-3 text-base text-surface-100" />
                      <div className="flex flex-wrap gap-2">
                        <button type="button" disabled={emailBusy || !emailInput.trim()} onClick={() => void emailRequest(`/admin/users/${compactUser.id}/account-email`, 'POST', { email: emailInput.trim() })} className="min-h-11 rounded-md bg-primary-600 px-3 text-sm text-white disabled:opacity-50">{emailBusy ? t('sendingEmail') : t('sendVerificationEmail')}</button>
                        <button type="button" onClick={() => { setEmailTarget(null); setEmailInput(''); }} className="min-h-11 rounded-md border border-surface-600 px-3 text-sm text-surface-200">{t('close')}</button>
                      </div>
                    </div>
                  ) : <button type="button" onClick={() => { setEmailTarget(compactUser.id); setEmailInput(''); }} className="min-h-11 rounded-md px-2 text-sm text-primary-300">{compactUser.account_email_status === 'verified' ? t('changeEmail') : t('registerEmail')}</button>)}
                  {(role === 'admin' || !['admin', 'operator'].includes(compactUser.role)) && compactUser.account_email_status === 'pending' && <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={emailBusy} onClick={() => void emailRequest(`/admin/users/${compactUser.id}/account-email/resend`, 'POST')} className="min-h-11 rounded-md border border-primary-500/40 px-3 text-sm text-primary-300 disabled:opacity-50">{t('resendEmail')}</button>
                    <button type="button" disabled={emailBusy} onClick={() => void emailRequest(`/admin/users/${compactUser.id}/account-email/pending`, 'DELETE')} className="min-h-11 rounded-md px-3 text-sm text-surface-300 disabled:opacity-50">{t('cancelPendingEmail')}</button>
                  </div>}
                </div>
                <div className="space-y-2 border-t border-surface-700 pt-4">
                  <label htmlFor="compact-user-role" className="block text-sm font-semibold text-surface-200">{t('role')}</label>
                  <select id="compact-user-role" value={compactUser.role} onChange={e => void handleRoleChange(compactUser.id, e.target.value)} disabled={compactUser.disabled || compactUser.username === currentUsername || (role !== 'admin' && ['admin', 'operator'].includes(compactUser.role))} className="min-h-11 w-full min-w-0 rounded-md border border-surface-700 bg-surface-900 px-3 text-base text-surface-100 disabled:opacity-50">
                    <option value="viewer">{t('roleViewer')}</option><option value="guest">{t('roleGuest')}</option><option value="member">{t('roleMember')}</option>
                    {role === 'admin' && <option value="operator">{t('roleOperator')}</option>}{role === 'admin' && <option value="admin">{t('roleAdmin')}</option>}
                  </select>
                  <h4 className="pt-2 text-sm font-semibold text-surface-200">{t('accessScope')}</h4>
                  <AccessScopeCell role={compactUser.role} projects={compactUser.projects || []} />
                </div>
                <div className="space-y-2 border-t border-surface-700 pt-4">
                  <h4 className="text-sm font-semibold text-surface-200">{t('actions')}</h4>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" ref={editReturnRef} onClick={() => setEditTarget(compactUser)} disabled={compactUser.disabled || (role !== 'admin' && ['admin', 'operator'].includes(compactUser.role))} className="min-h-11 rounded-md border border-surface-600 px-3 text-sm text-surface-200 disabled:opacity-50">{t('editUser')}</button>
                    {role === 'admin' && <button type="button" onClick={() => void sendPasswordResetEmail(compactUser)} disabled={emailBusy || !compactUser.account_email || compactUser.account_email_status !== 'verified' || !!compactUser.disabled || compactUser.approval_status !== 'active'} className="min-h-11 rounded-md border border-surface-600 px-3 text-sm text-surface-200 disabled:opacity-50">비밀번호 재설정 메일 보내기</button>}
                    <button type="button" onClick={() => { setResetPwUserId(compactUser.id); setResetPwError(''); }} disabled={role !== 'admin' || compactUser.disabled} className="min-h-11 rounded-md border border-surface-600 px-3 text-sm text-surface-200 disabled:opacity-50">{t('resetPassword')}</button>
                    {compactUser.disabled && compactUser.approval_status === 'active' ? <button type="button" onClick={() => void handleReactivate(compactUser)} disabled={role !== 'admin' && ['admin', 'operator'].includes(compactUser.role)} className="min-h-11 rounded-md border border-emerald-500/40 px-3 text-sm text-emerald-300 disabled:opacity-50">{t('reactivateUser')}</button> : !compactUser.disabled && <button type="button" onClick={() => void handleDelete(compactUser.id, compactUser.username)} disabled={compactUser.username === currentUsername || (role !== 'admin' && ['admin', 'operator'].includes(compactUser.role))} className="min-h-11 rounded-md border border-red-500/40 px-3 text-sm text-red-300 disabled:opacity-50">{t('disableUser')}</button>}
                  </div>
                  {resetPwUserId === compactUser.id && <div className="space-y-2 rounded-md border border-surface-700 p-3">
                    <label htmlFor="compact-reset-password" className="block text-sm text-surface-300">{t('newPassword')}</label>
                    <input id="compact-reset-password" type="password" value={resetPwValue} onChange={e => { setResetPwValue(e.target.value); setResetPwError(''); }} className="min-h-11 w-full rounded-md border border-surface-700 bg-surface-900 px-3 text-base text-surface-100" />
                    <label htmlFor="compact-reset-confirm" className="block text-sm text-surface-300">{t('confirmPassword')}</label>
                    <input id="compact-reset-confirm" type="password" value={resetPwConfirm} onChange={e => { setResetPwConfirm(e.target.value); setResetPwError(''); }} className="min-h-11 w-full rounded-md border border-surface-700 bg-surface-900 px-3 text-base text-surface-100" />
                    {resetPwError && <p role="alert" className="text-sm text-red-300">{resetPwError}</p>}
                    <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void handleResetPassword(compactUser.id)} className="min-h-11 rounded-md bg-primary-600 px-3 text-sm text-white">{t('common:confirm')}</button><button type="button" onClick={() => { setResetPwUserId(null); setResetPwValue(''); setResetPwConfirm(''); setResetPwError(''); }} className="min-h-11 rounded-md px-3 text-sm text-surface-300">{t('common:cancel')}</button></div>
                  </div>}
                </div>
                <div className="space-y-2 border-t border-surface-700 pt-4">
                  <p className="break-words text-sm text-surface-300">{t('lastLogin')}: {compactUser.last_login_at ? new Date(compactUser.last_login_at).toLocaleString() : t('neverLoggedIn')} · IP: <span className="break-all">{compactUser.last_login_ip || t('unknownIp')}</span></p>
                  <button type="button" onClick={() => void fetchEvents(compactUser.id)} className="min-h-11 rounded-md px-2 text-sm text-primary-300">{t('loadActivity')}</button>
                  {eventsError && <p role="alert" className="text-sm text-red-300">{eventsError}</p>}
                  {events.length > 0 && <ul className="divide-y divide-surface-700 text-sm">{events.map(e => <li key={e.id} className="break-all py-2">{new Date(e.created_at).toLocaleString()} · {e.event_type} · {e.ip_address || t('unknownIp')}</li>)}</ul>}
                  {eventCursor && <button type="button" onClick={() => void fetchEvents(compactUser.id, eventCursor)} className="min-h-11 text-primary-300">{t('loadMore')}</button>}
                  <p className="text-xs text-surface-400">{t('loginActivityHint')}</p>
                </div>
              </div>
            </section>
          ) : listedUsers.length ? (
            <ul className="divide-y divide-surface-700 rounded-lg border border-surface-700" aria-label={t('registeredUsers', { count: listedUsers.length })}>
              {listedUsers.map((u, index) => <li key={u.id} className="min-w-0 p-3">
                {u.disabled && (index === 0 || !listedUsers[index-1].disabled) && <h3 className="mb-3 text-sm font-semibold text-surface-400">비활성 계정 {disabledUsers.length}명</h3>}
                <button type="button" data-compact-user-id={u.id} onClick={() => { setSelected(u.id); setEvents([]); setEventCursor(null); setEventsError(''); setEmailTarget(null); setResetPwUserId(null); }} className="flex min-h-11 w-full min-w-0 flex-col items-start gap-1 rounded-md px-1 py-2 text-left focus-visible:ring-2 focus-visible:ring-primary-400">
                  <span className="break-words text-base font-semibold text-surface-100">{u.display_name || u.username}</span>
                  <span className="break-all font-mono text-sm text-surface-400">로그인 ID: {u.username} · ID {u.id}</span>
                  <span className="break-all text-sm text-surface-300">{u.account_email || t('accountEmailMissing')}</span>
                  <span className="flex flex-wrap gap-2 text-xs text-surface-300"><span className="tone-pill tone-muted px-2 py-1">{t(`role${u.role.charAt(0).toUpperCase()}${u.role.slice(1)}`, { defaultValue: u.role })}</span><span className="tone-pill tone-muted px-2 py-1">{u.disabled ? t('userFilter.disabled') : t(`approvalStatus.${u.approval_status || 'active'}`)}</span></span>
                  <span className="text-sm text-primary-300">{t('details')} →</span>
                </button>
              </li>)}</ul>
          ) : <p role="status" className="rounded-lg border border-surface-700 p-4 text-sm text-surface-300">{t('noMatchingUsers')}</p>}
        </div>
      )}

      {/* Desktop retains the dense table; compact view renders its own single set of controls. */}
      {!compact && <div className="rounded-lg border border-surface-700 overflow-x-auto">
        <table className="w-full min-w-[1050px]">
          <thead>
            <tr className="bg-surface-800/60 text-[13px] text-gray-500 uppercase tracking-wider">
              <th className="text-left px-4 py-2.5 font-semibold">표시 이름 · 로그인 ID</th>
              <th className="text-left px-4 py-2.5 font-semibold">{t('accountEmail')}</th>
              <th className="text-left px-4 py-2.5 font-semibold">{t('userStatus')}</th>
              <th className="text-left px-4 py-2.5 font-semibold">{t('lastLogin')}</th>
              <th className="text-left px-4 py-2.5 font-semibold">{t('role')}</th>
              <th className="text-left px-4 py-2.5 font-semibold">{t('accessScope')}</th>
              <th className="text-right px-4 py-2.5 font-semibold w-24">{t('actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-800/50">
            {listedUsers.map((u, index) => {
              const isSelf = u.username === currentUsername;
              return (
                <React.Fragment key={u.id}>
                {u.disabled && (index === 0 || !listedUsers[index-1].disabled) && <tr><th colSpan={7} className="bg-surface-800/40 px-4 py-3 text-left text-sm text-surface-400">비활성 계정 {disabledUsers.length}명</th></tr>}
                <tr className="hover:bg-surface-800/30 transition-colors">
                  {/* Name — display_name + username + affiliation 한 묶음 */}
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-2">
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-bold shrink-0 mt-0.5 ${
                        u.role === 'admin'
                          ? 'bg-primary-600/20 text-primary-400 border border-primary-500/30'
                          : u.role === 'operator'
                          ? 'tone-pill tone-warning'
                          : u.role === 'viewer'
                          ? 'tone-pill tone-muted'
                          : 'bg-surface-700 text-gray-400 border border-surface-600'
                      }`}>
                        {(u.display_name || u.username)[0].toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[15px] font-medium text-gray-200 truncate">
                            {u.display_name || <span className="text-gray-600 italic">{t('userDisplayName')}</span>}
                          </span>
                          {isSelf && <span className="text-[12px] text-gray-600 bg-surface-800 px-1.5 py-0.5 rounded">{t('common:you')}</span>}
                        </div>
                        <div className="text-[13px] text-gray-500 font-mono truncate">로그인 ID: {u.username}</div>
                        {u.affiliation && (
                          <div className="text-[13px] text-gray-500 truncate">{u.affiliation}</div>
                        )}
                      </div>
                    </div>
                  </td>

                  {/* Account email — always present as its own column, including legacy users without email. */}
                  <td className="px-4 py-3 align-top">
                    <div className="flex min-w-[180px] flex-col items-start gap-1">
                      <span className={`max-w-[260px] truncate text-[13px] ${u.account_email ? 'text-gray-300' : 'text-gray-600 italic'}`} title={u.account_email || t('accountEmailMissing')}>
                        {u.account_email || t('accountEmailMissing')}
                      </span>
                      {u.account_email && (
                        <span className={`rounded px-1.5 py-0.5 text-[11px] ${
                          u.account_email_status === 'verified'
                            ? 'bg-emerald-500/10 text-emerald-300'
                            : 'bg-amber-500/10 text-amber-300'
                        }`}>
                          {u.account_email_status === 'verified' ? t('accountEmailVerified') : t('accountEmailPending')}
                        </span>
                      )}
                      {(role === 'admin' || !['admin', 'operator'].includes(u.role)) && (emailTarget === u.id ? <div className="flex flex-wrap gap-1">
                        <input type="email" aria-label={`${u.username} 계정 이메일`} value={emailInput} onChange={e => setEmailInput(e.target.value)} placeholder="name@example.com" className="w-48 rounded border border-surface-700 bg-surface-900 px-2 py-1 text-gray-200" />
                        <button type="button" disabled={emailBusy || !emailInput.trim()} onClick={() => void emailRequest(`/admin/users/${u.id}/account-email`, 'POST', { email: emailInput.trim() })} className="min-h-9 rounded-md bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-primary-500 active:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:cursor-not-allowed disabled:opacity-50" aria-busy={emailBusy}>{emailBusy ? '보내는 중…' : '확인 메일 보내기'}</button>
                        <button type="button" onClick={() => { setEmailTarget(null); setEmailInput(''); }} className="min-h-9 rounded-md border border-surface-600 px-3 py-1.5 text-xs text-gray-300 transition-colors hover:bg-surface-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">닫기</button>
                      </div> : <button type="button" onClick={() => { setEmailTarget(u.id); setEmailInput(''); }} className="text-xs text-primary-300">{u.account_email_status === 'verified' ? '이메일 변경' : '이메일 등록'}</button>)}
                      {role === 'admin' && <button type="button" onClick={() => void sendPasswordResetEmail(u)} disabled={emailBusy || !u.account_email || u.account_email_status !== 'verified' || !!u.disabled || u.approval_status !== 'active'} className="min-h-11 rounded-md border border-surface-600 px-3 text-sm text-surface-200 disabled:opacity-50">비밀번호 재설정 메일 보내기</button>}
                      {(role === 'admin' || !['admin', 'operator'].includes(u.role)) && u.account_email_status === 'pending' && <div className="flex gap-2 text-xs text-primary-300">
                        <button type="button" disabled={emailBusy} onClick={() => void emailRequest(`/admin/users/${u.id}/account-email/resend`, 'POST')} className="rounded-md border border-primary-500/40 px-2 py-1 hover:bg-primary-500/15 disabled:opacity-50">{emailBusy ? '처리 중…' : '재발송'}</button>
                        <button type="button" disabled={emailBusy} onClick={() => void emailRequest(`/admin/users/${u.id}/account-email/pending`, 'DELETE')}>대기 취소</button>
                      </div>}
                    </div>
                  </td>

                  {/* Approval status */}
                  <td className="px-4 py-3 align-top">
                    <ApprovalStatusCell
                      user={u}
                      isAdmin={role === 'admin'}
                      onApprove={() => handleApproveUser(u.id)}
                      onReject={() => handleRejectUser(u.id)}
                    />
                  </td>

                  {/* Password */}
                  <td className="px-4 py-3">
                    <div className="text-xs text-surface-300">{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : t('neverLoggedIn')}</div>
                    <div className="mt-1 font-mono text-xs text-surface-500">{u.last_login_ip || t('unknownIp')}</div>
                  </td>

                  {/* Role */}
                  <td className="px-4 py-3">
                    <select
                      value={u.role}
                      onChange={(e) => handleRoleChange(u.id, e.target.value)}
                      disabled={u.disabled || isSelf || (role !== 'admin' && (u.role === 'admin' || u.role === 'operator'))}
                      className="bg-surface-900 border border-surface-700 text-gray-300 rounded-md px-2 py-1 text-[14px] disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <option value="viewer">{t('roleViewer')}</option>
                      <option value="guest">{t('roleGuest')}</option>
                      <option value="member">{t('roleMember')}</option>
                      {role === 'admin' && <option value="operator">{t('roleOperator')}</option>}
                      {role === 'admin' && <option value="admin">{t('roleAdmin')}</option>}
                    </select>
                  </td>

                  {/* Access scope — read-only, derived from role + project membership. */}
                  <td className="px-4 py-3">
                    <AccessScopeCell role={u.role} projects={u.projects || []} />
                  </td>

                  {/* Actions */}
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {resetPwUserId === u.id ? (
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-1">
                            <input
                              type="password"
                              value={resetPwValue}
                              onChange={(e) => { setResetPwValue(e.target.value); setResetPwError(''); }}
                              placeholder={t('newPassword')}
                              className="w-28 bg-surface-900 border border-surface-700 rounded-md px-2 py-1 text-[14px] text-gray-200 focus:outline-none focus:border-primary-500/50"
                              autoFocus
                            />
                            <input
                              type="password"
                              value={resetPwConfirm}
                              onChange={(e) => { setResetPwConfirm(e.target.value); setResetPwError(''); }}
                              placeholder={t('confirmPlaceholder')}
                              className={`w-28 bg-surface-900 border rounded-md px-2 py-1 text-[14px] text-gray-200 focus:outline-none focus:border-primary-500/50 ${
                                resetPwConfirm && resetPwValue !== resetPwConfirm ? 'border-red-500/50' : 'border-surface-700'
                              }`}
                              onKeyDown={(e) => e.key === 'Enter' && handleResetPassword(u.id)}
                            />
                            <button onClick={() => handleResetPassword(u.id)} className="p-1 text-primary-400 hover:text-primary-300 rounded" title={t('common:confirm')}>
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                            </button>
                            <button onClick={() => { setResetPwUserId(null); setResetPwValue(''); setResetPwConfirm(''); setResetPwError(''); }} className="p-1 text-gray-500 hover:text-gray-300 rounded" title={t('common:cancel')}>
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                          </div>
                          {resetPwError && <span className="text-[12px] text-red-400 pl-1">{resetPwError}</span>}
                        </div>
                      ) : (
                        <>
                          <button
                            onClick={() => setEditTarget(u)}
                            disabled={u.disabled || (role !== 'admin' && (u.role === 'admin' || u.role === 'operator'))}
                            className="p-1.5 text-gray-500 hover:text-primary-400 hover:bg-surface-800 rounded-md transition-colors"
                            title={t('editUser')}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                          </button>
                          <button onClick={() => { setSelected(selected === u.id ? null : u.id); setEvents([]); setEventCursor(null); setEventsError(''); }}
                            className="min-h-9 rounded-md px-2 text-xs text-primary-300 hover:bg-surface-800" aria-expanded={selected === u.id}>{t('details')}</button>
                          <button
                            onClick={() => setResetPwUserId(u.id)}
                            disabled={role !== 'admin' || u.disabled}
                            className="tone-warning p-1.5 text-gray-500 hover:text-[var(--tone-text)] hover:bg-surface-800 rounded-md transition-colors"
                            title={t('resetPassword')}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>
                          </button>
                          {u.disabled && u.approval_status === 'active' ? <button onClick={() => void handleReactivate(u)}
                            disabled={role !== 'admin' && (u.role === 'admin' || u.role === 'operator')}
                            className="min-h-9 rounded-md px-2 text-xs text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40">{t('reactivateUser')}</button> : !u.disabled && <button
                            onClick={() => handleDelete(u.id, u.username)}
                            disabled={isSelf || (role !== 'admin' && (u.role === 'admin' || u.role === 'operator'))}
                            className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-surface-800 rounded-md transition-colors disabled:opacity-20 disabled:cursor-not-allowed"
                            title={isSelf ? t('cannotDeleteSelf') : t('disableUser')}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                          </button>}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>}

      {!compact && selected !== null && listedUsers.some(u => u.id === selected) && <section aria-label={t('userDetails')} className="rounded-lg border border-surface-700 p-4 text-sm text-surface-300">
        {(() => { const u = listedUsers.find(u => u.id === selected)!; return <>
          <h3 className="text-base font-semibold text-surface-100">{u.display_name || u.username} · @{u.username}</h3>
          <p className="mt-2">{t('userStatus')}: {u.disabled ? t('userFilter.disabled') : u.approval_status} · {t('accountEmail')}: {u.account_email || t('accountEmailMissing')} · {t('accessScope')}: {(u.projects || []).map(p => p.name).join(', ') || t('noProjectAccess')}</p>
          <p className="mt-2 text-xs text-surface-400">{t('lastLogin')}: {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : t('neverLoggedIn')} · IP: {u.last_login_ip || t('unknownIp')}</p>
          <div className="mt-4 flex items-center gap-3"><h4 className="font-medium">{t('loginActivity')}</h4><button className="text-primary-300" onClick={() => void fetchEvents(u.id)}>{t('loadActivity')}</button></div>
          {eventsError && <p role="alert" className="text-red-300">{eventsError}</p>}
          {events.length > 0 && <ul className="mt-2 divide-y divide-surface-700">{events.map(e => <li key={e.id} className="py-2">{new Date(e.created_at).toLocaleString()} · {e.event_type} · {e.ip_address || t('unknownIp')}</li>)}</ul>}
          {eventCursor && <button className="mt-2 text-primary-300" onClick={() => void fetchEvents(u.id, eventCursor)}>{t('loadMore')}</button>}
          <p className="mt-2 text-xs text-surface-500">{t('loginActivityHint')}</p>
        </>; })()}
      </section>}

      {/* Edit user modal — admin/operator 가 다른 사용자 (또는 자기 본인) 의 이름·소속·username 편집 */}
      {editTarget && (
        <EditUserModal
          user={editTarget}
          isAdmin={role === 'admin'}
          isSelf={editTarget.username === currentUsername}
          onClose={closeEdit}
          onSaveProfile={async (fields) => {
            await handleProfileChange(editTarget.id, fields);
            closeEdit();
          }}
          onSaveUsername={async (newUsername) => {
            await handleUsernameChange(editTarget, newUsername);
            closeEdit();
          }}
        />
      )}
    </div>
  );
}

function ApprovalStatusCell({ user, isAdmin, onApprove, onReject, compact = false }: { user: User; isAdmin: boolean; onApprove: () => void; onReject: () => void; compact?: boolean }) {
  const { t } = useTranslation('admin');
  const status = user.approval_status || 'active';
  const statusClass = status === 'active'
    ? 'tone-success'
    : status === 'pending'
    ? 'tone-warning'
    : 'tone-danger';
  return (
    <div className="space-y-1.5 min-w-[130px]">
      <span className={`tone-pill px-2 py-0.5 text-[12px] ${user.disabled ? 'tone-muted' : statusClass}`}>
        {user.disabled ? t('userFilter.disabled') : t(`approvalStatus.${status}`)}
      </span>
      {user.signup_invite_code && (
        <div className="text-[12px] text-gray-500">
          code <span className="font-mono text-gray-400">{user.signup_invite_code}</span>
        </div>
      )}
      {!user.disabled && status === 'pending' && isAdmin && (
        <div className="flex flex-wrap gap-2 pt-1">
          <button onClick={onApprove} className={`tone-action tone-success px-3 rounded text-[12px] ${compact ? 'min-h-11' : 'min-h-9'}`} >{t('approve')}</button>
          <button onClick={onReject} className={`tone-action tone-danger px-3 rounded text-[12px] ${compact ? 'min-h-11' : 'min-h-9'}`}>{t('reject')}</button>
        </div>
      )}
    </div>
  );
}

function SignupInviteCodesPanel({
  token,
  invites,
  settings,
  onApprovalModeChange,
  onRefresh,
}: {
  token?: string | null;
  invites: SignupInviteCode[];
  settings: SignupSettings;
  onApprovalModeChange: (mode: SignupApprovalMode) => void;
  onRefresh: () => void;
}) {
  const headers = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }, [token]);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState({ code: '', label: '', defaultRole: 'member', maxUses: '20', expiresAt: '' });
  const [error, setError] = useState('');
  const { t } = useTranslation('admin');

  const recommend = async () => {
    const qs = draft.label ? `?label=${encodeURIComponent(draft.label)}` : '';
    const res = await fetch(`${API_BASE}/admin/signup-invites/recommend${qs}`, { headers: headers() });
    if (res.ok) {
      const data = await res.json();
      setDraft((d) => ({ ...d, code: data.code || d.code }));
    }
  };

  const createInvite = async () => {
    setError('');
    const res = await fetch(`${API_BASE}/admin/signup-invites`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({
        code: draft.code,
        label: draft.label,
        defaultRole: draft.defaultRole,
        maxUses: draft.maxUses ? Number(draft.maxUses) : null,
        expiresAt: draft.expiresAt || null,
      }),
    });
    if (res.ok) {
      setShowForm(false);
      setDraft({ code: '', label: '', defaultRole: 'member', maxUses: '20', expiresAt: '' });
      onRefresh();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || t('creationFailed'));
    }
  };

  const toggleDisabled = async (invite: SignupInviteCode) => {
    await fetch(`${API_BASE}/admin/signup-invites/${invite.id}`, {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ disabled: !invite.disabled }),
    });
    onRefresh();
  };

  return (
    <div className="rounded-lg border border-surface-700 bg-surface-800/20 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-surface-800 px-4 py-3">
        <div>
          <div className="text-[14px] font-semibold text-gray-300">{t('inviteCode')}</div>
          <div className="text-[13px] text-gray-500 mt-0.5">{t('inviteCodeIntro')}</div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-lg border border-surface-700 bg-surface-900/60 p-1">
            <button
              onClick={() => onApprovalModeChange('auto')}
              className={`px-2.5 py-1 rounded-md text-[13px] transition-colors ${settings.approvalMode === 'auto' ? 'tone-action tone-success' : 'text-gray-500 hover:text-gray-300'}`}
            >
              {t('autoApproveMode')}
            </button>
            <button
              onClick={() => onApprovalModeChange('manual')}
              className={`px-2.5 py-1 rounded-md text-[13px] transition-colors ${settings.approvalMode === 'manual' ? 'tone-action tone-warning' : 'text-gray-500 hover:text-gray-300'}`}
            >
              {t('manualApproveMode')}
            </button>
          </div>
          <button onClick={() => setShowForm(!showForm)} className="min-h-11 text-[14px] px-3 py-1.5 rounded-lg bg-primary-600/20 border border-primary-500/30 text-primary-300 hover:bg-primary-600/30">
            {showForm ? t('close') : t('addInviteCode')}
          </button>
        </div>
      </div>
      <div className="px-4 py-2 border-b border-surface-800 bg-surface-900/20 text-[13px] text-gray-500">
        {t('currentSettings')} {settings.approvalMode === 'auto' ? t('autoApproveDescription') : t('manualApproveDescription')}
      </div>
      {showForm && (
        <div className="p-4 border-b border-surface-800 bg-surface-900/30 space-y-3">
          {error && <div className="text-[14px] text-red-400">{error}</div>}
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder={t('inviteLabelPlaceholder')} className="min-h-11 min-w-0 w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[14px] text-gray-200" />
            <div className="flex min-w-0 gap-1">
              <input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} placeholder={t('inviteCodePlaceholder')} className="min-h-11 min-w-0 flex-1 bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[14px] text-gray-200 font-mono" />
              <button onClick={recommend} className="min-h-11 px-2 rounded-md bg-surface-800 text-[13px] text-gray-300">{t('recommend')}</button>
            </div>
            <select value={draft.defaultRole} onChange={(e) => setDraft({ ...draft, defaultRole: e.target.value })} className="min-h-11 min-w-0 w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[14px] text-gray-200">
              <option value="viewer">viewer</option>
              <option value="guest">guest</option>
              <option value="member">member</option>
              <option value="operator">operator</option>
            </select>
            <input type="number" min="1" value={draft.maxUses} onChange={(e) => setDraft({ ...draft, maxUses: e.target.value })} placeholder={t('usageCountPlaceholder')} className="min-h-11 min-w-0 w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[14px] text-gray-200" />
            <input type="date" value={draft.expiresAt} onChange={(e) => setDraft({ ...draft, expiresAt: e.target.value })} className="min-h-11 min-w-0 w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[14px] text-gray-200" />
          </div>
          <div className="flex justify-end">
            <button onClick={createInvite} className="min-h-11 px-4 py-2 text-[14px] bg-primary-600 hover:bg-primary-500 text-white rounded-md">{t('create')}</button>
          </div>
        </div>
      )}
      <div className="divide-y divide-surface-800/70">
        {invites.length === 0 ? (
          <div className="px-4 py-4 text-[14px] text-gray-500">{t('noInviteCodes')}</div>
        ) : invites.map((invite) => (
          <div key={invite.id} className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-3 text-[14px]">
            <span className="break-all font-mono text-primary-300 bg-primary-500/10 border border-primary-500/20 px-2 py-1 rounded">{invite.code}</span>
            <span className="text-gray-300 min-w-[120px]">{invite.label || '—'}</span>
            <span className="text-gray-500">role {invite.default_role}</span>
            <span className="text-gray-500">used {invite.used_count}{invite.max_uses ? `/${invite.max_uses}` : ''}</span>
            {invite.expires_at && <span className="text-gray-500">until {invite.expires_at.slice(0, 10)}</span>}
            {invite.disabled && <span className="text-red-400">disabled</span>}
            <div className="ml-auto flex gap-1">
              <button onClick={() => toggleDisabled(invite)} className="min-h-11 px-3 rounded bg-surface-800 text-gray-300 hover:text-white">{invite.disabled ? t('enable') : t('disable')}</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface EditUserModalProps {
  user: User;
  isAdmin: boolean;
  isSelf: boolean;
  onClose: () => void;
  onSaveProfile: (fields: { displayName?: string; affiliation?: string }) => Promise<void>;
  onSaveUsername: (newUsername: string) => Promise<void>;
}

function EditUserModal({ user, isAdmin, isSelf, onClose, onSaveProfile, onSaveUsername }: EditUserModalProps) {
  const { t } = useTranslation('admin');
  const [displayName, setDisplayName] = useState(user.display_name ?? '');
  const [affiliation, setAffiliation] = useState(user.affiliation ?? '');
  const [usernameDraft, setUsernameDraft] = useState(user.username);
  const [saving, setSaving] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const first = modalRef.current?.querySelector<HTMLInputElement>('input:not([disabled])');
    first?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onCloseRef.current(); }
      if (event.key !== 'Tab' || !modalRef.current) return;
      const controls = Array.from(modalRef.current.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled])'));
      const firstControl = controls[0], lastControl = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === firstControl) { event.preventDefault(); lastControl?.focus(); }
      else if (!event.shiftKey && document.activeElement === lastControl) { event.preventDefault(); firstControl?.focus(); }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => { document.removeEventListener('keydown', onKeyDown, true); };
  }, []);

  const profileChanged =
    (displayName.trim() || null) !== (user.display_name ?? null) ||
    (affiliation.trim() || null) !== (user.affiliation ?? null);
  const usernameChanged = usernameDraft.trim() !== user.username;

  // admin 만 username 변경 가능. 본인은 admin 이라도 자기 username 변경은 OK.
  const canEditUsername = isAdmin;

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // 순서: profile 먼저, 그다음 username (username 변경은 토큰 invalidate 동반).
      if (profileChanged) {
        await onSaveProfile({
          displayName: displayName.trim(),
          affiliation: affiliation.trim(),
        });
      }
      if (canEditUsername && usernameChanged) {
        await onSaveUsername(usernameDraft.trim());
      }
      if (!profileChanged && !(canEditUsername && usernameChanged)) {
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center p-3 sm:p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="edit-user-title" className="relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-md flex-col overflow-y-auto overscroll-contain rounded-xl border border-surface-700 bg-surface-900 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl sm:p-6">
        <div className="space-y-4">
          <div>
            <h3 id="edit-user-title" className="text-[17px] font-bold text-gray-100">{t('editUserTitle')}</h3>
            <p className="text-[13px] text-gray-500 mt-1">{t('editUserSubtitle')}</p>
          </div>

          <div>
            <label htmlFor="edit-user-display-name" className="block text-[13px] text-gray-500 mb-1">{t('userDisplayName')}</label>
            <input
              type="text"
              id="edit-user-display-name" value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t('userDisplayNamePlaceholder')}
              className="min-h-11 w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[15px] text-gray-200 focus:outline-none focus:border-primary-500/50"
            />
          </div>

          <div>
            <label htmlFor="edit-user-affiliation" className="block text-[13px] text-gray-500 mb-1">{t('userAffiliation')}</label>
            <input
              type="text"
              id="edit-user-affiliation" value={affiliation}
              onChange={(e) => setAffiliation(e.target.value)}
              placeholder={t('userAffiliationPlaceholder')}
              className="min-h-11 w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[15px] text-gray-200 focus:outline-none focus:border-primary-500/50"
            />
          </div>

          <div>
            <label htmlFor="edit-user-username" className="block text-[13px] text-gray-500 mb-1">
              {t('username')} {!canEditUsername && <span className="text-gray-600">({t('adminOnly')})</span>}
              {isSelf && canEditUsername && <span className="tone-warning tone-text opacity-70">⚠ {t('common:you')}</span>}
            </label>
            <input
              type="text"
              id="edit-user-username" value={usernameDraft}
              onChange={(e) => setUsernameDraft(e.target.value)}
              disabled={!canEditUsername}
              className="min-h-11 w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[15px] text-gray-200 font-mono focus:outline-none focus:border-primary-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <p className="text-[12px] text-gray-600 mt-1">{t('usernameRules')}</p>
          </div>

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="min-h-11 px-4 py-2 text-[14px] text-gray-400 hover:text-gray-200 transition-colors rounded-md"
            >
              {t('common:cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving || (!profileChanged && !(canEditUsername && usernameChanged))}
              className="min-h-11 px-4 py-2 text-[14px] bg-primary-600 hover:bg-primary-500 text-white rounded-md transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AccessScopeCell({ role, projects }: { role?: string; projects: Array<{ id: string; name: string; role?: string }> }) {
  const { t } = useTranslation('admin');
  const isPrivileged = role === 'admin' || role === 'operator';
  const visibleProjects = projects.slice(0, 3);
  const hiddenCount = Math.max(0, projects.length - visibleProjects.length);
  return (
    <div className="max-w-[260px]">
      <div className={`text-[14px] font-medium ${isPrivileged ? 'tone-warning tone-text' : 'text-gray-300'}`}>
        {isPrivileged ? t('accessWorkspaceWide') : t('accessProjectBased')}
      </div>
      <div className="text-[12px] text-gray-600 leading-snug mt-0.5">
        {isPrivileged ? t('accessWorkspaceWideDesc') : t('accessProjectBasedDesc')}
      </div>
      {!isPrivileged && (
        <div className="mt-1.5 flex flex-wrap gap-1" title={projects.map(p => p.name).join(', ')}>
          {visibleProjects.length > 0 ? visibleProjects.map((p) => (
            <span key={p.id} className="px-1.5 py-0.5 rounded bg-surface-800 border border-surface-700 text-[12px] text-gray-400 max-w-[90px] truncate">
              {p.name}
            </span>
          )) : (
            <span className="tone-warning tone-text text-[12px] opacity-80">{t('noProjectAccess')}</span>
          )}
          {hiddenCount > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-surface-800 border border-surface-700 text-[12px] text-gray-500">
              +{hiddenCount}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
