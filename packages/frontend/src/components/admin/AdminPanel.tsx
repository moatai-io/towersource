import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useSettingsStore } from '../../stores/settings-store';
import { useConfirm } from '../../hooks/useDialog';
import { getCurrentRole } from '../../utils/auth';
import { RuntimeBoxPanel } from '../runtime/RuntimeBoxPanel';
import { UsagePanel } from '../usage/UsagePanel';

const API_BASE = '/api';

interface User {
  id: number;
  username: string;
  role: string;
  approval_status?: 'active' | 'pending' | 'rejected' | 'suspended';
  password_plain: string;
  display_name: string | null;
  affiliation: string | null;
  signup_invite_code?: string | null;
  signup_invite_label?: string | null;
  customer_vms?: Array<{ id: string; name: string }>;
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

interface CustomerVmOption {
  id: string;
  name: string;
  profile?: string;
}

interface AdminPanelProps {
  open: boolean;
  onClose: () => void;
  token?: string | null;
}

interface PersonalCredentialsPanelProps {
  open: boolean;
  onClose: () => void;
  token?: string | null;
}

// 2026-05-04: AdminPanel 탭별 권한 (decisions/2026-05-04-five-role-model.md)
//   admin    → users / usage / ai / prompts / runtime / credentials / system
//   operator → users / runtime / credentials
// 2026-05-09: heartbeat 탭 제거 (decisions/2026-04-28-heartbeat-deprecation.md Phase 4)
// 2026-06-10: legacy organization groups removed; project_members is the only project access model.
// 2026-05-27: models/accounts 는 admin 전용 AI 설정 탭으로 통합. operator 는 AI 계정/모델을 보지 않는다.
// 2026-05-31: AdminPanel skills tab removed. Skills are managed in the first-class Skills Market / registry UI,
// not a duplicate admin settings table that can bypass personal-first/project guards.
type AdminTab = 'users' | 'agents' | 'usage' | 'ai' | 'prompts' | 'runtime' | 'credentials' | 'system';

const OPERATOR_ALLOWED_TABS: ReadonlySet<AdminTab> = new Set(['users', 'agents', 'runtime', 'credentials']);

function isTabAllowed(tab: AdminTab, role: string | null | undefined): boolean {
  if (role === 'admin') return true;
  if (role === 'operator') return OPERATOR_ALLOWED_TABS.has(tab);
  return false;
}

export function AdminPanel({ open, onClose, token }: AdminPanelProps) {
  const { t } = useTranslation('admin');
  // role 은 JWT payload 가 단일 source of truth (utils/auth.ts).
  const role = getCurrentRole() || 'member';
  const panelTitle = role === 'operator' ? t('operatorPanel') : t('adminPanel');
  const [tab, setTab] = useState<AdminTab>('users');

  // operator 가 진입 시 기본 탭이 허용되지 않으면 첫 허용 탭으로 이동
  useEffect(() => {
    if (open && !isTabAllowed(tab, role)) {
      setTab('users');
    }
  }, [open, tab, role]);

  if (!open) return null;

  const tabClass = (key: AdminTab) =>
    `px-4 py-2 text-[15px] font-medium transition-colors border-b-2 ${
      tab === key
        ? 'text-primary-400 border-primary-500'
        : 'text-gray-500 hover:text-gray-300 border-transparent'
    }`;

  // helper: 탭이 현재 role 에 허용되어야만 렌더
  const renderTab = (key: AdminTab, label: string) => {
    if (!isTabAllowed(key, role)) return null;
    return (
      <button key={key} className={tabClass(key)} onClick={() => setTab(key)}>{label}</button>
    );
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-surface-900 border border-surface-700 rounded-xl shadow-2xl w-[calc(100vw-2rem)] max-w-[1600px] max-h-[92vh] mx-4 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-800 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-primary-600/20 border border-primary-500/30 flex items-center justify-center">
              <svg className="w-4 h-4 text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <h2 className="text-[18px] font-bold text-gray-100">{panelTitle}</h2>
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-500 hover:text-gray-300 hover:bg-surface-800 rounded-lg transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex overflow-x-auto border-b border-surface-800 px-6 shrink-0">
          {renderTab('users', t('users'))}
          {renderTab('agents', '에이전트 관리')}
          {renderTab('usage', '사용량')}
          {renderTab('ai', t('aiSettings'))}
          {renderTab('prompts', t('systemPrompt'))}
          {renderTab('runtime', 'Runtime Box')}
          {renderTab('credentials', 'Connections')}
          {renderTab('system', t('system'))}
        </div>

        {/* Content — 허용 안 된 탭이 어쩌다 active 면 아무것도 안 그림 (안전망) */}
        <div className="flex-1 overflow-y-auto p-6">
          {isTabAllowed(tab, role) && (
            <>
              {tab === 'users' && <UserManagement token={token} />}
              {tab === 'agents' && <AgentLifecycleManagement token={token} />}
              {tab === 'usage' && <UsagePanel embedded />}
              {tab === 'ai' && <AiSettingsManagement token={token} />}
              {tab === 'prompts' && <SystemPromptEditor token={token} />}
              {tab === 'runtime' && <RuntimeBoxPanel />}
              {tab === 'credentials' && <CredentialVaultManagement token={token} mode="global" />}
              {tab === 'system' && <SystemInfo />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ───── Agent lifecycle tab ─────

type ManagedAgent = {
  id: string; name: string; lifecycleStatus: string; retiredAt: string | null;
  retirementReason: string | null; ownerUsername: string | null;
  sessionCount: number; runtimeBoxCount: number;
};

type PurgePreview = {
  intentId: string; proposalHash: string; expiresAt: string; applyAvailable: false;
  impact: {
    projectId: string; projectName: string; lifecycleStatus: string; rootPath: string | null;
    folder: { exists: boolean; bytes: number | null; measurement: string };
    database: Record<string, number>;
    credentials: { dedicated: number; shared: number; reviewRequired: number };
    blockers: string[]; warnings: string[];
  };
};

function AgentLifecycleManagement({ token }: { token?: string | null }) {
  const [status, setStatus] = useState<'active' | 'retired'>('active');
  const [agents, setAgents] = useState<ManagedAgent[]>([]);
  const [preview, setPreview] = useState<PurgePreview | null>(null);
  const [typedName, setTypedName] = useState('');
  const [purgeConfirmed, setPurgeConfirmed] = useState(false);
  const [purgeJob, setPurgeJob] = useState<{ id: string; status: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const headers = useCallback(() => ({
    'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }), [token]);
  const refresh = useCallback(async () => {
    setLoading(true); setError(''); setPreview(null); setTypedName(''); setPurgeConfirmed(false); setPurgeJob(null);
    try {
      const res = await fetch(`${API_BASE}/admin/agents?status=${status}`, { headers: headers() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '에이전트 목록을 불러오지 못했습니다.');
      setAgents(data.agents || []);
    } catch (err: any) { setError(err.message); } finally { setLoading(false); }
  }, [headers, status]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!purgeJob || ['completed', 'failed_before_destructive', 'recovery_required'].includes(purgeJob.status)) return;
    const timer = window.setInterval(async () => {
      const res = await fetch(`${API_BASE}/admin/agent-purge-jobs/${purgeJob.id}`, { headers: headers() });
      if (!res.ok) return;
      const data = await res.json();
      setPurgeJob({ id: data.id, status: data.status });
      if (data.status === 'completed') window.clearInterval(timer);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [headers, purgeJob]);
  const inspect = async (id: string) => {
    setError('');
    const res = await fetch(`${API_BASE}/admin/agents/${id}/purge/preview`, { method: 'POST', headers: headers(), body: '{}' });
    const data = await res.json();
    if (!res.ok) { setError(data.error || '영구 삭제 영향을 계산하지 못했습니다.'); return; }
    setPreview(data); setTypedName(''); setPurgeConfirmed(false); setPurgeJob(null);
  };
  const applyPurge = async () => {
    if (!preview) return;
    setError('');
    const res = await fetch(`${API_BASE}/admin/agents/${preview.impact.projectId}/purge/apply`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ intentId: preview.intentId, proposalHash: preview.proposalHash, typedName, confirmed: purgeConfirmed }),
    });
    const data = await res.json();
    if (!res.ok) { setError(data.error || '영구 삭제 작업을 시작하지 못했습니다.'); return; }
    setPurgeJob({ id: data.jobId, status: data.status });
  };
  return <div className="space-y-5">
    <div className="flex items-start justify-between gap-4">
      <div><h3 className="text-lg font-semibold text-surface-100">에이전트 관리</h3><p className="text-sm text-surface-400 mt-1">폐기와 복구 상태를 확인하고 영구 삭제 영향을 미리 봅니다. 이 화면에서는 실제 삭제하지 않습니다.</p></div>
      <div className="flex rounded-lg border border-surface-700 p-1">
        {(['active', 'retired'] as const).map(key => <button key={key} onClick={() => setStatus(key)} className={`px-3 py-1.5 rounded-md text-sm ${status === key ? 'bg-primary-600/20 text-primary-700 dark:text-primary-200' : 'text-surface-400 hover:text-surface-100'}`}>{key === 'active' ? '운영 중' : '폐기됨'}</button>)}
      </div>
    </div>
    {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
    {loading ? <div className="text-sm text-surface-400">불러오는 중…</div> : <div className="overflow-x-auto rounded-lg border border-surface-700"><table className="w-full text-sm"><thead className="bg-surface-800 text-surface-400"><tr><th className="p-3 text-left">에이전트</th><th className="p-3 text-left">소유자</th><th className="p-3 text-right">대화</th><th className="p-3 text-right">Runtime</th><th className="p-3 text-right">작업</th></tr></thead><tbody>{agents.map(agent => <tr key={agent.id} className="border-t border-surface-800"><td className="p-3"><div className="font-medium text-surface-100">{agent.name}</div><div className="text-xs text-surface-500">{agent.lifecycleStatus}{agent.retiredAt ? ` · ${new Date(agent.retiredAt).toLocaleString()}` : ''}</div></td><td className="p-3 text-surface-300">{agent.ownerUsername || '시스템'}</td><td className="p-3 text-right text-surface-300">{agent.sessionCount}</td><td className="p-3 text-right text-surface-300">{agent.runtimeBoxCount}</td><td className="p-3 text-right">{status === 'retired' ? <button onClick={() => inspect(agent.id)} className="rounded-md border border-red-500/30 px-3 py-1.5 text-red-300 hover:bg-red-500/10">영구 삭제 영향 보기</button> : <span className="text-xs text-surface-500">먼저 폐기 필요</span>}</td></tr>)}</tbody></table>{agents.length === 0 && <div className="p-8 text-center text-sm text-surface-500">해당 상태의 에이전트가 없습니다.</div>}</div>}
    {preview && <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-5 space-y-3"><div><h4 className="font-semibold text-surface-100">{preview.impact.projectName} · 영구 삭제 영향</h4><p className="text-xs text-surface-500 mt-1">미리보기 만료: {new Date(preview.expiresAt).toLocaleString()} · 이 작업은 대화·파일·전용 Credential을 복구할 수 없게 삭제합니다.</p></div><div className="grid grid-cols-2 md:grid-cols-4 gap-3">{Object.entries(preview.impact.database).map(([key, value]) => <div key={key} className="rounded-lg bg-surface-900/60 p-3"><div className="text-xs text-surface-500">{key}</div><div className="text-lg font-semibold text-surface-100">{value}</div></div>)}</div><div className="text-sm text-surface-300">전용 Credential {preview.impact.credentials.dedicated} · 공유 Credential {preview.impact.credentials.shared} · 검토 필요 {preview.impact.credentials.reviewRequired}</div>{preview.impact.blockers.length > 0 ? <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">차단 사유: {preview.impact.blockers.join(', ')}</div> : <div className="space-y-3 border-t border-red-500/20 pt-3"><label className="block text-sm text-surface-300">확인을 위해 에이전트 이름 <strong className="text-surface-100">{preview.impact.projectName}</strong>을 입력하세요.<input value={typedName} onChange={event => setTypedName(event.target.value)} className="mt-2 w-full rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-surface-100" /></label><label className="flex items-start gap-2 text-sm text-surface-300"><input type="checkbox" checked={purgeConfirmed} onChange={event => setPurgeConfirmed(event.target.checked)} className="mt-1" /><span>대화, 파일, Runtime, 에이전트 전용 Credential의 영구 삭제를 이해했습니다.</span></label><button disabled={typedName !== preview.impact.projectName || !purgeConfirmed || !!purgeJob} onClick={applyPurge} className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">영구 삭제 작업 시작</button>{purgeJob && <div className="rounded-lg border border-primary-500/30 bg-primary-500/10 p-3 text-sm text-primary-700 dark:text-primary-200">작업 {purgeJob.id} · 상태 {purgeJob.status}. 완료·실패·복구 필요 상태까지 자동 갱신됩니다.</div>}</div>}</div>}
  </div>;
}

// ───── Users Tab ─────

function UserManagement({ token }: { token?: string | null }) {
  const { t } = useTranslation('admin');
  const confirm = useConfirm();
  // role 은 모달이 admin only 인 username 편집을 가드하기 위해 필요. JWT 가 single source.
  const role = getCurrentRole() || 'member';
  const [users, setUsers] = useState<User[]>([]);
  const [invites, setInvites] = useState<SignupInviteCode[]>([]);
  const [signupSettings, setSignupSettings] = useState<SignupSettings>({ approvalMode: 'auto' });
  const [customerVms, setCustomerVms] = useState<CustomerVmOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newUser, setNewUser] = useState({
    username: '',
    password: '',
    passwordConfirm: '',
    role: 'member',
    displayName: '',
    affiliation: '',
  });
  const [resetPwUserId, setResetPwUserId] = useState<number | null>(null);
  const [resetPwValue, setResetPwValue] = useState('');
  const [resetPwConfirm, setResetPwConfirm] = useState('');
  const [resetPwError, setResetPwError] = useState('');
  const [error, setError] = useState('');
  // EditUserModal 대상. null 이면 모달 닫힘.
  const [editTarget, setEditTarget] = useState<User | null>(null);

  const headers = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }, [token]);

  const fetchUsers = useCallback(async () => {
    try {
      const usersRes = await fetch(`${API_BASE}/admin/users`, { headers: headers() });
      if (usersRes.ok) setUsers(await usersRes.json());
      if (role === 'admin') {
        const invitesRes = await fetch(`${API_BASE}/admin/signup-invites`, { headers: headers() });
        if (invitesRes.ok) setInvites(await invitesRes.json());
        const settingsRes = await fetch(`${API_BASE}/admin/signup-settings`, { headers: headers() });
        if (settingsRes.ok) setSignupSettings(await settingsRes.json());
        const customerRes = await fetch(`${API_BASE}/admin/self-hosted-servers`, { headers: headers() });
        if (customerRes.ok) setCustomerVms(await customerRes.json());
      }
    } catch {} finally { setLoading(false); }
  }, [headers, role]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

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
    try {
      const { passwordConfirm: _, displayName, affiliation, ...rest } = newUser;
      const payload = {
        ...rest,
        displayName: displayName.trim(),
        affiliation: affiliation.trim() || null,
      };
      const res = await fetch(`${API_BASE}/admin/users`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setShowForm(false);
        setNewUser({
          username: '', password: '', passwordConfirm: '', role: 'member',
          displayName: '', affiliation: '',
        });
        fetchUsers();
      } else {
        const data = await res.json();
        setError(data.error || t('creationFailed'));
      }
    } catch { setError(t('serverError')); }
  };

  const handleRoleChange = async (userId: number, role: string) => {
    await fetch(`${API_BASE}/admin/users/${userId}`, {
      method: 'PATCH', headers: headers(),
      body: JSON.stringify({ role }),
    });
    fetchUsers();
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
    await fetch(`${API_BASE}/admin/users/${userId}/approve`, { method: 'POST', headers: headers() });
    fetchUsers();
  };

  const handleRejectUser = async (userId: number) => {
    await fetch(`${API_BASE}/admin/users/${userId}/reject`, {
      method: 'POST', headers: headers(), body: JSON.stringify({}),
    });
    fetchUsers();
  };

  const handleCustomerVmToggle = async (user: User, customerId: string, checked: boolean) => {
    const current = new Set((user.customer_vms || []).map(c => c.id));
    if (checked) current.add(customerId); else current.delete(customerId);
    await fetch(`${API_BASE}/admin/users/${user.id}/self-hosted-servers`, {
      method: 'PUT', headers: headers(),
      body: JSON.stringify({ customerIds: Array.from(current) }),
    });
    fetchUsers();
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

  const handleDelete = async (userId: number, username: string) => {
    const ok = await confirm({
      title: t('disableUser', { defaultValue: 'Disable user' }),
      message: t('disableUserConfirm', { username }),
      confirmLabel: t('disable', { defaultValue: 'Disable' }),
      danger: true,
    });
    if (!ok) return;
    await fetch(`${API_BASE}/admin/users/${userId}`, {
      method: 'DELETE', headers: headers(),
    });
    fetchUsers();
  };

  if (loading) {
    return <div className="text-base text-gray-500 py-8 text-center">{t('common:loading')}</div>;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-[15px] text-gray-400">
          {t('registeredUsers', { count: users.length })}
        </p>
        <button
          onClick={() => setShowForm(!showForm)}
          className="text-[14px] px-3 py-1.5 rounded-lg bg-primary-600/20 border border-primary-500/30 text-primary-300 hover:bg-primary-600/30 transition-colors font-medium"
        >
          {showForm ? t('common:cancel') : t('addUser')}
        </button>
      </div>

      <div className="rounded-lg border border-surface-700 bg-surface-800/25 px-4 py-3">
        <div className="text-[14px] font-semibold text-gray-300">{t('userOnboardingTitle')}</div>
        <div className="mt-1 text-[13px] text-gray-500 leading-relaxed">
          {t('userOnboardingIntro')}
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 text-[13px]">
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

      {/* Create form */}
      {showForm && (
        <div className="p-4 bg-surface-800/40 rounded-lg border border-surface-700 space-y-3">
          {error && <div className="text-[14px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">{error}</div>}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] text-gray-500 mb-1">{t('userDisplayName')}</label>
              <input
                type="text"
                value={newUser.displayName}
                onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })}
                className="w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[15px] text-gray-200 focus:outline-none focus:border-primary-500/50"
                placeholder={t('userDisplayNamePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[13px] text-gray-500 mb-1">{t('userAffiliation')}</label>
              <input
                type="text"
                value={newUser.affiliation}
                onChange={(e) => setNewUser({ ...newUser, affiliation: e.target.value })}
                className="w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[15px] text-gray-200 focus:outline-none focus:border-primary-500/50"
                placeholder={t('userAffiliationPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[13px] text-gray-500 mb-1">{t('username')}</label>
              <input
                type="text"
                value={newUser.username}
                onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                className="w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[15px] text-gray-200 focus:outline-none focus:border-primary-500/50"
                placeholder={t('usernamePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[13px] text-gray-500 mb-1">{t('password')}</label>
              <input
                type="text"
                value={newUser.password}
                onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                className="w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[15px] text-gray-200 font-mono focus:outline-none focus:border-primary-500/50"
                placeholder={t('passwordHint')}
                autoComplete="off"
              />
            </div>
            <div>
              <label className="block text-[13px] text-gray-500 mb-1">{t('confirmPassword')}</label>
              <input
                type="text"
                value={newUser.passwordConfirm}
                onChange={(e) => setNewUser({ ...newUser, passwordConfirm: e.target.value })}
                className={`w-full bg-surface-900 border rounded-md px-3 py-2 text-[15px] text-gray-200 font-mono focus:outline-none focus:border-primary-500/50 ${
                  newUser.passwordConfirm && newUser.password !== newUser.passwordConfirm ? 'border-red-500/50' : 'border-surface-700'
                }`}
                placeholder={t('confirmPasswordHint')}
                autoComplete="off"
              />
            </div>
            <div>
              <label className="block text-[13px] text-gray-500 mb-1">{t('role')}</label>
              <select
                value={newUser.role}
                onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                className="w-full bg-surface-900 border border-surface-700 text-gray-300 rounded-md px-3 py-2 text-[15px]"
              >
                <option value="viewer">{t('roleViewer')}</option>
                <option value="guest">{t('roleGuest')}</option>
                <option value="member">{t('roleMember')}</option>
                <option value="operator">{t('roleOperator')}</option>
                {role === 'admin' && <option value="customer_manager">{t('roleCustomerManager')}</option>}
                <option value="admin">{t('roleAdmin')}</option>
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
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => { setShowForm(false); setError(''); }}
              className="px-4 py-2 text-[14px] text-gray-400 hover:text-gray-200 transition-colors rounded-md"
            >
              {t('common:cancel')}
            </button>
            <button
              onClick={handleCreate}
              className="px-4 py-2 text-[14px] bg-primary-600 hover:bg-primary-500 text-white rounded-md transition-colors font-medium"
            >
              {t('common:create')}
            </button>
          </div>
        </div>
      )}

      {role === 'admin' && (
        <SignupInviteCodesPanel
          token={token}
          invites={invites}
          settings={signupSettings}
          onApprovalModeChange={handleSignupApprovalModeChange}
          onRefresh={fetchInvites}
        />
      )}

      {/* User table */}
      <div className="rounded-lg border border-surface-700 overflow-x-auto">
        <table className="w-full min-w-[900px]">
          <thead>
            <tr className="bg-surface-800/60 text-[13px] text-gray-500 uppercase tracking-wider">
              <th className="text-left px-4 py-2.5 font-semibold">{t('name')}</th>
              <th className="text-left px-4 py-2.5 font-semibold">상태</th>
              <th className="text-left px-4 py-2.5 font-semibold">{t('password')}</th>
              <th className="text-left px-4 py-2.5 font-semibold">{t('role')}</th>
              <th className="text-left px-4 py-2.5 font-semibold">{t('customerVms')}</th>
              <th className="text-left px-4 py-2.5 font-semibold">{t('accessScope')}</th>
              <th className="text-right px-4 py-2.5 font-semibold w-24">{t('actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-800/50">
            {users.map((u) => {
              const isSelf = u.username === currentUsername;
              return (
                <tr key={u.id} className="hover:bg-surface-800/30 transition-colors">
                  {/* Name — display_name + username + affiliation 한 묶음 */}
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-2">
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-bold shrink-0 mt-0.5 ${
                        u.role === 'admin'
                          ? 'bg-primary-600/20 text-primary-400 border border-primary-500/30'
                          : u.role === 'operator'
                          ? 'tone-pill tone-warning'
                          : u.role === 'customer_manager'
                          ? 'tone-pill tone-success'
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
                        <div className="text-[13px] text-gray-500 font-mono truncate">@{u.username}</div>
                        {u.affiliation && (
                          <div className="text-[13px] text-gray-500 truncate">{u.affiliation}</div>
                        )}
                      </div>
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
                    <PasswordCell password={u.password_plain} userId={u.id} token={token} onUpdate={fetchUsers} />
                  </td>

                  {/* Role */}
                  <td className="px-4 py-3">
                    <select
                      value={u.role}
                      onChange={(e) => handleRoleChange(u.id, e.target.value)}
                      disabled={isSelf}
                      className="bg-surface-900 border border-surface-700 text-gray-300 rounded-md px-2 py-1 text-[14px] disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <option value="viewer">{t('roleViewer')}</option>
                      <option value="guest">{t('roleGuest')}</option>
                      <option value="member">{t('roleMember')}</option>
                      <option value="operator">{t('roleOperator')}</option>
                      {role === 'admin' && <option value="customer_manager">{t('roleCustomerManager')}</option>}
                      <option value="admin">{t('roleAdmin')}</option>
                    </select>
                  </td>

                  {/* Self-hosted servers — customer_manager scope mapping */}
                  <td className="px-4 py-3 align-top">
                    {role === 'admin' && u.role === 'customer_manager' ? (
                      <div className="flex flex-col gap-1.5 min-w-[150px]">
                        {customerVms.length === 0 ? (
                          <span className="text-[13px] text-gray-600">{t('noCustomerVms')}</span>
                        ) : customerVms.map((c) => {
                          const checked = (u.customer_vms || []).some(v => v.id === c.id);
                          return (
                            <label key={c.id} className="flex items-center gap-1.5 text-[13px] text-gray-400">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => handleCustomerVmToggle(u, c.id, e.target.checked)}
                                className="accent-primary-500"
                              />
                              <span>{c.name}</span>
                            </label>
                          );
                        })}
                      </div>
                    ) : (u.customer_vms && u.customer_vms.length > 0) ? (
                      <div className="flex flex-wrap gap-1">
                        {u.customer_vms.map(c => (
                          <span key={c.id} className="tone-pill tone-success px-1.5 py-0.5 rounded text-[12px]">{c.name}</span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-[13px] text-gray-600">—</span>
                    )}
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
                            className="p-1.5 text-gray-500 hover:text-primary-400 hover:bg-surface-800 rounded-md transition-colors"
                            title={t('editUser')}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                          </button>
                          <button
                            onClick={() => setResetPwUserId(u.id)}
                            className="tone-warning p-1.5 text-gray-500 hover:text-[var(--tone-text)] hover:bg-surface-800 rounded-md transition-colors"
                            title={t('resetPassword')}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>
                          </button>
                          <button
                            onClick={() => handleDelete(u.id, u.username)}
                            disabled={isSelf}
                            className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-surface-800 rounded-md transition-colors disabled:opacity-20 disabled:cursor-not-allowed"
                            title={isSelf ? t('cannotDeleteSelf') : t('disableUser')}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Edit user modal — admin/operator 가 다른 사용자 (또는 자기 본인) 의 이름·소속·username 편집 */}
      {editTarget && (
        <EditUserModal
          user={editTarget}
          isAdmin={role === 'admin'}
          isSelf={editTarget.username === currentUsername}
          onClose={() => setEditTarget(null)}
          onSaveProfile={async (fields) => {
            await handleProfileChange(editTarget.id, fields);
            setEditTarget(null);
          }}
          onSaveUsername={async (newUsername) => {
            await handleUsernameChange(editTarget, newUsername);
            setEditTarget(null);
          }}
        />
      )}
    </div>
  );
}

function ApprovalStatusCell({ user, isAdmin, onApprove, onReject }: { user: User; isAdmin: boolean; onApprove: () => void; onReject: () => void }) {
  const status = user.approval_status || 'active';
  const statusClass = status === 'active'
    ? 'tone-success'
    : status === 'pending'
    ? 'tone-warning'
    : 'tone-danger';
  return (
    <div className="space-y-1.5 min-w-[130px]">
      <span className={`tone-pill px-2 py-0.5 text-[12px] ${statusClass}`}>
        {status}
      </span>
      {user.signup_invite_code && (
        <div className="text-[12px] text-gray-500">
          code <span className="font-mono text-gray-400">{user.signup_invite_code}</span>
        </div>
      )}
      {status === 'pending' && isAdmin && (
        <div className="flex gap-1 pt-1">
          <button onClick={onApprove} className="tone-action tone-success px-2 py-1 rounded text-[12px]">승인</button>
          <button onClick={onReject} className="tone-action tone-danger px-2 py-1 rounded text-[12px]">거절</button>
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
      setError(data.error || '초대 코드 생성 실패');
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
      <div className="px-4 py-3 border-b border-surface-800 flex items-center justify-between gap-4">
        <div>
          <div className="text-[14px] font-semibold text-gray-300">초대 코드</div>
          <div className="text-[13px] text-gray-500 mt-0.5">회원가입에 사용할 코드를 만들고 승인 방식을 관리합니다.</div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 rounded-lg border border-surface-700 bg-surface-900/60 p-1">
            <button
              onClick={() => onApprovalModeChange('auto')}
              className={`px-2.5 py-1 rounded-md text-[13px] transition-colors ${settings.approvalMode === 'auto' ? 'tone-action tone-success' : 'text-gray-500 hover:text-gray-300'}`}
            >
              코드 있으면 자동 승인
            </button>
            <button
              onClick={() => onApprovalModeChange('manual')}
              className={`px-2.5 py-1 rounded-md text-[13px] transition-colors ${settings.approvalMode === 'manual' ? 'tone-action tone-warning' : 'text-gray-500 hover:text-gray-300'}`}
            >
              관리자 승인 필요
            </button>
          </div>
          <button onClick={() => setShowForm(!showForm)} className="text-[14px] px-3 py-1.5 rounded-lg bg-primary-600/20 border border-primary-500/30 text-primary-300 hover:bg-primary-600/30">
            {showForm ? '닫기' : '+ 초대 코드'}
          </button>
        </div>
      </div>
      <div className="px-4 py-2 border-b border-surface-800 bg-surface-900/20 text-[13px] text-gray-500">
        현재 설정: {settings.approvalMode === 'auto' ? '초대 코드가 맞으면 바로 가입되고 관리자에게 알림이 갑니다.' : '초대 코드가 맞아도 pending 상태로 만들고, 관리자가 승인해야 로그인할 수 있습니다.'}
      </div>
      {showForm && (
        <div className="p-4 border-b border-surface-800 bg-surface-900/30 space-y-3">
          {error && <div className="text-[14px] text-red-400">{error}</div>}
          <div className="grid grid-cols-5 gap-2">
            <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="라벨/고객명" className="bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[14px] text-gray-200" />
            <div className="flex gap-1">
              <input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} placeholder="코드" className="min-w-0 flex-1 bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[14px] text-gray-200 font-mono" />
              <button onClick={recommend} className="px-2 rounded-md bg-surface-800 text-[13px] text-gray-300">추천</button>
            </div>
            <select value={draft.defaultRole} onChange={(e) => setDraft({ ...draft, defaultRole: e.target.value })} className="bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[14px] text-gray-200">
              <option value="viewer">viewer</option>
              <option value="guest">guest</option>
              <option value="member">member</option>
              <option value="operator">operator</option>
              <option value="customer_manager">customer_manager</option>
            </select>
            <input type="number" min="1" value={draft.maxUses} onChange={(e) => setDraft({ ...draft, maxUses: e.target.value })} placeholder="사용 횟수" className="bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[14px] text-gray-200" />
            <input type="date" value={draft.expiresAt} onChange={(e) => setDraft({ ...draft, expiresAt: e.target.value })} className="bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[14px] text-gray-200" />
          </div>
          <div className="flex justify-end">
            <button onClick={createInvite} className="px-4 py-2 text-[14px] bg-primary-600 hover:bg-primary-500 text-white rounded-md">생성</button>
          </div>
        </div>
      )}
      <div className="divide-y divide-surface-800/70">
        {invites.length === 0 ? (
          <div className="px-4 py-4 text-[14px] text-gray-500">아직 초대 코드가 없습니다.</div>
        ) : invites.map((invite) => (
          <div key={invite.id} className="px-4 py-3 flex items-center gap-3 text-[14px]">
            <span className="font-mono text-primary-300 bg-primary-500/10 border border-primary-500/20 px-2 py-1 rounded">{invite.code}</span>
            <span className="text-gray-300 min-w-[120px]">{invite.label || '—'}</span>
            <span className="text-gray-500">role {invite.default_role}</span>
            <span className="text-gray-500">used {invite.used_count}{invite.max_uses ? `/${invite.max_uses}` : ''}</span>
            {invite.expires_at && <span className="text-gray-500">until {invite.expires_at.slice(0, 10)}</span>}
            {invite.disabled && <span className="text-red-400">disabled</span>}
            <div className="ml-auto flex gap-1">
              <button onClick={() => toggleDisabled(invite)} className="px-2 py-1 rounded bg-surface-800 text-gray-300 hover:text-white">{invite.disabled ? '활성화' : '비활성화'}</button>
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
    <div className="fixed inset-0 z-[210] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-surface-900 border border-surface-700 rounded-xl shadow-2xl w-full max-w-md mx-4 p-6 space-y-4">
        <div>
          <h3 className="text-[17px] font-bold text-gray-100">{t('editUserTitle')}</h3>
          <p className="text-[13px] text-gray-500 mt-1">{t('editUserSubtitle')}</p>
        </div>

        <div>
          <label className="block text-[13px] text-gray-500 mb-1">{t('userDisplayName')}</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t('userDisplayNamePlaceholder')}
            className="w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[15px] text-gray-200 focus:outline-none focus:border-primary-500/50"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-[13px] text-gray-500 mb-1">{t('userAffiliation')}</label>
          <input
            type="text"
            value={affiliation}
            onChange={(e) => setAffiliation(e.target.value)}
            placeholder={t('userAffiliationPlaceholder')}
            className="w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[15px] text-gray-200 focus:outline-none focus:border-primary-500/50"
          />
        </div>

        <div>
          <label className="block text-[13px] text-gray-500 mb-1">
            {t('username')} {!canEditUsername && <span className="text-gray-600">({t('adminOnly')})</span>}
            {isSelf && canEditUsername && <span className="tone-warning tone-text opacity-70">⚠ {t('common:you')}</span>}
          </label>
          <input
            type="text"
            value={usernameDraft}
            onChange={(e) => setUsernameDraft(e.target.value)}
            disabled={!canEditUsername}
            className="w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[15px] text-gray-200 font-mono focus:outline-none focus:border-primary-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <p className="text-[12px] text-gray-600 mt-1">{t('usernameRules')}</p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-[14px] text-gray-400 hover:text-gray-200 transition-colors rounded-md"
          >
            {t('common:cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || (!profileChanged && !(canEditUsername && usernameChanged))}
            className="px-4 py-2 text-[14px] bg-primary-600 hover:bg-primary-500 text-white rounded-md transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('save')}
          </button>
        </div>
      </div>
    </div>
  );
}

function PasswordCell({ password, userId, token, onUpdate }: { password: string; userId: number; token?: string | null; onUpdate: () => void }) {
  const { t } = useTranslation('admin');
  const [visible, setVisible] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!draft) return;
    if (draft.length < 8) { setError(t('minCharsShort')); return; }
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/admin/users/${userId}/password`, {
      method: 'PATCH', headers: h, body: JSON.stringify({ password: draft }),
    });
    if (res.ok) {
      setEditing(false); setDraft(''); setError('');
      onUpdate();
    } else {
      const data = await res.json();
      setError(data.error || t('common:failed'));
    }
  };

  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setError(''); }}
            placeholder={t('newPassword')}
            className="w-28 bg-surface-900 border border-surface-700 rounded-md px-2 py-1 text-[14px] text-gray-200 font-mono focus:outline-none focus:border-primary-500/50"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          />
          <button onClick={handleSave} className="p-0.5 text-primary-400 hover:text-primary-300" title={t('common:save')}>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
          </button>
          <button onClick={() => { setEditing(false); setDraft(''); setError(''); }} className="p-0.5 text-gray-500 hover:text-gray-300" title={t('common:cancel')}>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        {error && <span className="text-[12px] text-red-400">{error}</span>}
      </div>
    );
  }

  if (!password) {
    return (
      <button onClick={() => setEditing(true)} className="text-[13px] text-gray-600 hover:text-primary-400 italic transition-colors" title={t('setPassword')}>
        {t('setPassword')}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <span className="text-[14px] font-mono text-gray-400">{visible ? password : '••••••••'}</span>
      <button
        onClick={() => setVisible(!visible)}
        className="p-0.5 text-gray-600 hover:text-gray-400 transition-colors"
        title={visible ? t('hide') : t('show')}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {visible
            ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
            : <><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></>
          }
        </svg>
      </button>
      <button
        onClick={() => { setDraft(password); setEditing(true); }}
        className="tone-warning p-0.5 text-gray-600 hover:text-[var(--tone-text)] transition-colors"
        title={t('changePassword')}
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
      </button>
    </div>
  );
}

function AccessScopeCell({ role, projects }: { role?: string; projects: Array<{ id: string; name: string; role?: string }> }) {
  const { t } = useTranslation('admin');
  const isPrivileged = role === 'admin' || role === 'operator' || role === 'customer_manager';
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

// ───── System Prompt Tab ─────

interface SystemPromptData {
  id: number;
  name: string;
  prompt: string;
  updated_at: string;
}

interface PromptInspection {
  session: { id: string; name: string; engine: string; model: string | null; cwd: string };
  generatedAt: string;
  exactness: 'runtime-reconstruction' | 'tower-builder-reconstruction';
  caveat: string;
  blocks: Array<{ id: string; source: string; content: string; characters: number; estimatedTokens: number; sha256: string }>;
  total: { characters: number; estimatedTokens: number; sha256: string };
}

function SystemPromptEditor({ token }: { token?: string | null }) {
  const { t } = useTranslation('admin');
  const [prompts, setPrompts] = useState<SystemPromptData[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [inspectSessionId, setInspectSessionId] = useState('');
  const [inspection, setInspection] = useState<PromptInspection | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);

  const headers = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }, [token]);

  const fetchPrompts = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/system-prompts`, { headers: headers() });
      if (res.ok) setPrompts(await res.json());
    } catch {} finally { setLoading(false); }
  }, [headers]);

  useEffect(() => { fetchPrompts(); }, [fetchPrompts]);

  const handleEdit = (p: SystemPromptData) => {
    setEditingName(p.name);
    setEditDraft(p.prompt);
    setSavedAt(null);
  };

  const handleSave = async () => {
    if (!editingName) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/admin/system-prompts/${editingName}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ prompt: editDraft }),
      });
      if (res.ok) {
        setSavedAt(new Date().toLocaleTimeString());
        fetchPrompts();
      }
    } catch {} finally { setSaving(false); }
  };

  const handleCancel = () => {
    setEditingName(null);
    setEditDraft('');
    setSavedAt(null);
  };

  const handleInspect = async () => {
    const sessionId = inspectSessionId.trim();
    if (!sessionId) return;
    setInspecting(true);
    setInspectError(null);
    setInspection(null);
    try {
      const res = await fetch(`${API_BASE}/admin/prompt-inspector/${encodeURIComponent(sessionId)}`, { headers: headers() });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || 'Prompt inspection failed');
      setInspection(body);
    } catch (err: any) {
      setInspectError(err?.message || 'Prompt inspection failed');
    } finally {
      setInspecting(false);
    }
  };

  if (loading) {
    return <div className="text-base text-gray-500 py-8 text-center">{t('common:loading')}</div>;
  }

  // If editing, show full-screen editor
  if (editingName) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold text-gray-200">{editingName}</span>
            <span className="text-[13px] text-gray-600">{t('systemPromptLabel')}</span>
          </div>
          <div className="flex items-center gap-2">
            {savedAt && (
              <span className="tone-success tone-text text-[13px]">{t('promptSavedAt', { time: savedAt })}</span>
            )}
            <button
              onClick={handleCancel}
              className="text-[14px] px-3 py-1.5 rounded-lg text-gray-400 hover:text-gray-200 transition-colors"
            >
              {t('common:cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="text-[14px] px-3 py-1.5 rounded-lg bg-primary-600 hover:bg-primary-500 text-white transition-colors font-medium disabled:opacity-50"
            >
              {saving ? t('common:saving') : t('common:save')}
            </button>
          </div>
        </div>
        <textarea
          value={editDraft}
          onChange={(e) => setEditDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
              e.preventDefault();
              handleSave();
            }
          }}
          className="w-full h-[400px] bg-surface-900 border border-surface-700 rounded-lg px-4 py-3 text-[15px] text-gray-200 font-mono leading-relaxed resize-none focus:outline-none focus:border-primary-500/50"
          placeholder={t('enterSystemPrompt')}
          autoFocus
        />
        <div className="text-[13px] text-gray-600">
          {t('promptEditorIntro')}
          <br />
          {t('promptEditorTip')}
        </div>
      </div>
    );
  }

  // List view
  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-surface-700 p-4 space-y-4">
        <div>
          <h3 className="text-[15px] font-semibold text-surface-100">Session Prompt Inspector</h3>
          <p className="text-[13px] text-surface-500 mt-1">Session ID를 입력하면 현재 서버 상태로 재구성한 시스템 프롬프트를 블록별로 표시합니다. 실제 비밀값 패턴은 항상 마스킹됩니다.</p>
        </div>
        <div className="flex gap-2">
          <input
            value={inspectSessionId}
            onChange={(e) => setInspectSessionId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleInspect(); }}
            placeholder="Session UUID"
            className="flex-1 rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-[14px] text-surface-100 font-mono focus:outline-none focus:border-primary-500"
          />
          <button onClick={handleInspect} disabled={inspecting || !inspectSessionId.trim()} className="rounded-lg bg-primary-600 px-4 py-2 text-[14px] font-medium text-white hover:bg-primary-500 disabled:opacity-50">
            {inspecting ? '재구성 중' : '검토하기'}
          </button>
        </div>
        {inspectError && <div className="tone-danger tone-text text-[13px]">{inspectError}</div>}
        {inspection && (
          <div className="space-y-4">
            <div className="rounded-lg bg-surface-800/50 p-3 text-[13px] text-surface-300 space-y-1">
              <div><span className="text-surface-500">Session</span> {inspection.session.name} · {inspection.session.engine} · {inspection.session.model || 'default'}</div>
              <div><span className="text-surface-500">Total</span> {inspection.total.characters.toLocaleString()} chars · 약 {inspection.total.estimatedTokens.toLocaleString()} tokens</div>
              <div className="font-mono break-all"><span className="text-surface-500">SHA-256</span> {inspection.total.sha256}</div>
              <div className="tone-warning tone-text pt-1">{inspection.caveat}</div>
            </div>
            {inspection.blocks.map((item) => (
              <details key={item.id} open className="rounded-lg border border-surface-700 overflow-hidden">
                <summary className="cursor-pointer px-3 py-2 bg-surface-800/60 text-[13px] text-surface-200">
                  <span className="font-semibold">{item.id}</span> · {item.characters.toLocaleString()} chars · 약 {item.estimatedTokens.toLocaleString()} tokens
                  <span className="block text-[12px] text-surface-500 mt-0.5">{item.source}</span>
                </summary>
                <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words p-4 text-[13px] leading-relaxed text-surface-200 bg-surface-950">{item.content}</pre>
              </details>
            ))}
          </div>
        )}
      </section>

      <div className="flex items-center justify-between">
        <p className="text-[15px] text-gray-400">
          {t('promptListLead')}{' '}
          {t('promptDefaultApplyBefore')}
          <span className="text-gray-200 font-semibold">{t('common:default')}</span>
          {t('promptDefaultApplyAfter')}
        </p>
      </div>

      <div className="rounded-lg border border-surface-700 divide-y divide-surface-800/50">
        {prompts.map((p) => (
          <div key={p.id} className="px-4 py-3 hover:bg-surface-800/30 transition-colors">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-semibold text-gray-200">{p.name}</span>
                {p.name === 'default' && (
                  <span className="text-[12px] bg-primary-600/20 text-primary-400 border border-primary-500/30 px-1.5 py-0.5 rounded-full">{t('common:active')}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-gray-600">
                  {t('promptUpdatedAt', { date: new Date(p.updated_at).toLocaleDateString() })}
                </span>
                <button
                  onClick={() => handleEdit(p)}
                  className="text-[14px] px-2.5 py-1 rounded-md text-gray-400 hover:text-primary-400 hover:bg-surface-800 transition-colors"
                >
                  {t('common:edit')}
                </button>
              </div>
            </div>
            <pre className="text-[14px] text-gray-500 font-mono whitespace-pre-wrap line-clamp-3 leading-relaxed">
              {p.prompt}
            </pre>
          </div>
        ))}
      </div>

      <div className="p-3 bg-surface-800/30 rounded-lg border border-surface-700/50">
        <h4 className="text-[13px] font-semibold text-gray-500 uppercase tracking-wider mb-2">{t('common:howItWorks')}</h4>
        <div className="text-[14px] text-gray-500 space-y-1">
          <p>{t('promptHowItWorks')}</p>
          <div className="font-mono text-[13px] bg-surface-900/50 rounded px-3 py-2 text-gray-400 mt-1">
            [your prompt here]<br/>
            <br/>
            User: john (role: member)<br/>
            System package management requires IT team assistance.<br/>
            Your workspace is restricted to: ~/workspace
          </div>
        </div>
      </div>
    </div>
  );
}

// ───── Credentials Tab ─────

interface WorkspaceCredential {
  id: string;
  kind: string;
  provider: string;
  display_name: string;
  secret_name: string;
  default_env_name: string | null;
  scope: string;
  owner_user_id?: number | null;
  metadata?: Record<string, unknown>;
  enabled: boolean;
  rotated_at: string | null;
  updated_at: string;
}

interface CredentialTargetSync {
  id: number;
  credential_id: string;
  project_id: string | null;
  target_type: string;
  target_ref: { repo?: string; secret_name?: string };
  last_status: string | null;
  last_checked_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  provider?: string;
  kind?: string;
  display_name?: string;
}

interface ProjectOption {
  id: string;
  name: string;
  rootPath?: string | null;
}

interface CredentialProjectPolicy {
  project_id: string;
  credential_id: string;
  mode: 'inherit' | 'allow' | 'deny' | 'override';
  target_env_name: string | null;
  updated_at: string | null;
}

interface CredentialAdminConnectionOverview {
  summary: {
    connections: number;
    credentials: number;
    profiles: number;
    projects: number;
    defaultConnections: number;
    needsAttention: number;
    disabled: number;
  };
  connections: Array<{
    id: string;
    source: 'profile' | 'credential';
    credentialId?: string;
    profileId?: string;
    displayName: string;
    provider: string;
    connectionType: string;
    riskLevel: 'low' | 'medium' | 'high';
    enabled: boolean;
    defaultOn?: boolean;
    defaultScope?: string | null;
    defaultReason?: string | null;
    status: 'connected' | 'needs_attention' | 'disabled' | 'off';
    readiness: {
      access: { status: 'connected' | 'off' | 'blocked' | 'mixed'; connectedProjectCount: number; blockedProjectCount: number };
      materialization: { status: 'verified' | 'failed' | 'unknown'; lastCheckedAt: string | null };
      providerHealth: { status: 'ready' | 'invalid' | 'reauth_required' | 'degraded' | 'unknown' | 'unsupported'; checkedAt: string | null; reasonCode: string | null; action: 'none' | 'test' | 'rotate' | 'reauth' | 'inspect' };
      effectiveStatus: 'ready' | 'needs_attention' | 'connected_unverified' | 'off' | 'disabled';
    };
    publicEnvNames: string[];
    secretEnvNames: string[];
    credentials: Array<{ id: string; displayName: string; provider: string | null; credentialType: string; envName: string; scope: string | null; enabled: boolean; allowedActions?: { compare: boolean; reveal: boolean; inspect: boolean; replacementAction: 'rotate' | 'reauth'; reason: 'ordinary_secret' | 'structured_credential' | 'oauth_token' | 'ssh_private_key' } }>;
    projects: Array<{ projectId: string; projectName: string; status: string; reason: string; mode?: string | null; lastUsedAt?: string | null }>;
    targets: CredentialTargetSync[];
    warnings: Array<{ projectId?: string; projectName?: string; message: string }>;
    stats: { totalProjects: number; connectedProjects: number; blockedProjects: number; attentionProjects: number; targetIssues: number };
    lastUsedAt: string | null;
  }>;
}

interface CredentialBundleTypeField {
  id: string;
  label: string;
  envName: string;
  required: boolean;
  secret: boolean;
  envNameEditable?: boolean;
  placeholder?: string;
}

interface CredentialBundleType {
  id: string;
  provider: string;
  label: string;
  description: string;
  defaultInstanceId: string;
  defaultDisplayName: string;
  fields: CredentialBundleTypeField[];
}

interface CredentialTypeField {
  id: string;
  label: string;
  required: boolean;
  secret: boolean;
  multiline?: boolean;
  placeholder?: string;
}

interface CredentialType {
  id: string;
  provider: string;
  label: string;
  description: string;
  materialization: 'env' | 'file';
  secretFieldId: string;
  defaultCredentialId: string;
  defaultDisplayName: string;
  defaultSecretName: string;
  defaultEnvName: string;
  defaultPathEnvName?: string;
  defaultFilename?: string;
  defaultMode?: string;
  fields: CredentialTypeField[];
}

interface OAuthProviderConnection {
  id: string;
  label: string;
  description: string;
  configured: boolean;
  authPath: string;
  capabilities: string[];
  connected: boolean;
  status: 'connected' | 'reauth_required' | 'not_connected';
  statusReason?: string;
  nickname?: string;
  tokenExpiresAt?: number;
  hasRefreshToken: boolean;
  runtimeCredential?: {
    kind: string;
    envName: string;
  };
}

const API_KEY_PROVIDER_PRESETS: Record<string, {
  label: string;
  id: string;
  displayName: string;
  secretName: string;
  defaultEnvName: string;
  scope: 'workspace' | 'internal-default' | 'project';
}> = {
  aligo: {
    label: 'Aligo',
    id: 'aligo-api-key',
    displayName: 'Aligo API key',
    secretName: 'ALIGO_API_KEY',
    defaultEnvName: 'ALIGO_API_KEY',
    scope: 'project',
  },
  gemini: {
    label: 'Gemini',
    id: 'gemini-default',
    displayName: 'Gemini 기본 API key',
    secretName: 'GEMINI_API_KEY',
    defaultEnvName: 'GEMINI_API_KEY',
    scope: 'internal-default',
  },
  openai: {
    label: 'OpenAI',
    id: 'openai-api-key',
    displayName: 'OpenAI API key',
    secretName: 'OPENAI_API_KEY',
    defaultEnvName: 'OPENAI_API_KEY',
    scope: 'workspace',
  },
  openaiImage: {
    label: 'OpenAI Image',
    id: 'openai-image-default',
    displayName: 'OpenAI image API key',
    secretName: 'OPENAI_IMAGE_API_KEY',
    defaultEnvName: 'OPENAI_IMAGE_API_KEY',
    scope: 'workspace',
  },
  naver: {
    label: 'Naver',
    id: 'naver-api-key',
    displayName: 'Naver API key',
    secretName: 'NAVER_API_KEY',
    defaultEnvName: 'NAVER_API_KEY',
    scope: 'workspace',
  },
  notion: {
    label: 'Notion',
    id: 'notion-api-key',
    displayName: 'Notion API key',
    secretName: 'NOTION_API_KEY',
    defaultEnvName: 'NOTION_API_KEY',
    scope: 'workspace',
  },
  tiro: {
    label: 'Tiro',
    id: 'tiro-default',
    displayName: 'Tiro default API key',
    secretName: 'TIRO_KEY',
    defaultEnvName: 'TIRO_KEY',
    scope: 'workspace',
  },
  custom: {
    label: '직접 입력',
    id: 'custom-api-key',
    displayName: '사용자 지정 API key',
    secretName: 'CUSTOM_API_KEY',
    defaultEnvName: 'CUSTOM_API_KEY',
    scope: 'project',
  },
};

function apiKeyPreset(provider: string) {
  return API_KEY_PROVIDER_PRESETS[provider] ?? API_KEY_PROVIDER_PRESETS.custom;
}

function apiKeyIdFromService(service: string): string {
  const base = service.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'custom';
  return `${base}-api-key`.slice(0, 80);
}

function apiKeyEnvFromService(service: string): string {
  const base = service.toUpperCase().trim().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'CUSTOM';
  return `${base}_API_KEY`.slice(0, 64);
}

function apiKeyDisplayNameFromService(service: string): string {
  const trimmed = service.trim();
  return trimmed ? `${trimmed} API key` : '사용자 지정 API key';
}

function apiKeyFormFromProvider(provider: string) {
  const preset = apiKeyPreset(provider);
  return {
    id: preset.id,
    provider,
    displayName: preset.displayName,
    secretName: preset.secretName,
    defaultEnvName: preset.defaultEnvName,
    scope: preset.scope,
    secretValue: '',
  };
}

function apiKeyFormFromServiceName(service: string, currentSecretValue = '') {
  const normalized = service.toLowerCase().trim();
  const preset = API_KEY_PROVIDER_PRESETS[normalized];
  if (preset) return { ...apiKeyFormFromProvider(normalized), secretValue: currentSecretValue };
  const envName = apiKeyEnvFromService(service);
  return {
    id: apiKeyIdFromService(service),
    provider: normalized || service.trim(),
    displayName: apiKeyDisplayNameFromService(service),
    secretName: envName,
    defaultEnvName: envName,
    scope: 'workspace' as const,
    secretValue: currentSecretValue,
  };
}

function friendlyProvider(provider: string): string {
  const normalized = provider.toLowerCase();
  return API_KEY_PROVIDER_PRESETS[normalized]?.label || provider;
}

function adminText(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, { ns: 'admin', ...options });
}

function friendlyScope(scope: string): string {
  const key = ({ personal: 'personal', 'internal-default': 'internalDefault', project: 'project', workspace: 'workspace' } as const)[scope as 'personal'];
  return key ? adminText(`credentialConnections.scope.${key}`) : scope;
}

function friendlyTargetType(type: string): string {
  const key = ({ github_actions_secret: 'githubActions', azure_containerapp_env: 'azureAppEnv', runtime_box_env: 'runtimeBox', gws_config: 'gwsCli' } as const)[type as 'github_actions_secret'];
  return key ? adminText(`credentialConnections.targetType.${key}`) : type;
}

function credentialTypeLabel(credential: WorkspaceCredential): string {
  const credentialType = typeof credential.metadata?.credential_type === 'string' ? credential.metadata.credential_type : credential.kind;
  if (credentialType === 'ssh_private_key') return adminText('credentialConnections.credentialType.sshPrivateKey');
  if (credential.kind === 'api_key') return adminText('credentialConnections.credentialType.apiKey');
  return String(credentialType || credential.kind);
}

function pathEnvNameForCredential(credential: WorkspaceCredential): string | null {
  const materialization = credential.metadata?.materialization;
  if (materialization && typeof materialization === 'object' && !Array.isArray(materialization)) {
    const envName = (materialization as Record<string, unknown>).env_name;
    if (typeof envName === 'string' && envName.trim()) return envName;
  }
  const pathEnvName = credential.metadata?.path_env_name;
  return typeof pathEnvName === 'string' && pathEnvName.trim() ? pathEnvName : null;
}

function formatDateTime(value: string | null): string {
  if (!value) return adminText('credentialConnections.noRecord');
  return new Date(value).toLocaleString();
}

function credentialHealth(credential: WorkspaceCredential, targets: CredentialTargetSync[]) {
  if (!credential.enabled) return { label: '비활성', className: 'tone-muted' };
  const relatedTargets = targets.filter(t => t.credential_id === credential.id);
  if (relatedTargets.some(t => t.last_status === 'error' || t.last_error)) {
    return { label: '동기화 오류', className: 'tone-danger' };
  }
  if (relatedTargets.some(t => t.last_status === 'missing' || !t.last_status)) {
    return { label: '동기화 확인 필요', className: 'tone-warning' };
  }
  return { label: 'Vault 저장됨', className: 'tone-success' };
}

function connectionStatusStyle(status: string) {
  if (status === 'connected') return { label: '프로젝트 연결됨', className: 'tone-success' };
  if (status === 'needs_attention') return { label: '확인 필요', className: 'tone-warning' };
  if (status === 'disabled') return { label: '꺼짐', className: 'tone-muted' };
  return { label: '사용 안 함', className: 'tone-muted' };
}

function connectionReadinessStyle(connection: CredentialAdminConnectionOverview['connections'][number]) {
  const health = connection.readiness.providerHealth.status;
  if (connection.readiness.effectiveStatus === 'ready') return { label: '사용 가능', className: 'tone-success', description: '프로젝트 연결과 실제 인증 확인이 모두 완료됐습니다.' };
  if (health === 'invalid') return { label: 'API 키 교체 필요', className: 'tone-danger', description: '저장된 인증정보가 유효하지 않습니다. 새 인증정보로 교체해야 합니다.' };
  if (health === 'reauth_required') return { label: '다시 로그인 필요', className: 'tone-warning', description: '저장된 로그인이 만료되었거나 취소되었습니다. 서비스를 다시 연결하세요.' };
  if (health === 'degraded') return { label: '일부 기능 확인 필요', className: 'tone-warning', description: '연결은 유지되지만 일부 기능의 실제 사용 상태를 확인해야 합니다.' };
  if (connection.readiness.effectiveStatus === 'connected_unverified') return { label: '연결됐지만 실제 확인 안 됨', className: 'tone-warning', description: '프로젝트에는 연결됐지만 공급자 인증이 실제로 동작하는지 아직 확인되지 않았습니다.' };
  const style = connectionStatusStyle(connection.status);
  return { ...style, description: connection.status === 'disabled' ? '이 Connection은 현재 비활성화되어 있습니다.' : '이 Connection을 사용하는 프로젝트가 없습니다.' };
}

function connectionPrimaryAction(_connection: CredentialAdminConnectionOverview['connections'][number]) {
  return { label: '관리', kind: 'detail' as const };
}

function riskStyle(risk: string) {
  if (risk === 'high') return 'tone-danger';
  if (risk === 'medium') return 'tone-warning';
  return 'tone-muted';
}

function connectionPurpose(connection: CredentialAdminConnectionOverview['connections'][number]): string {
  const haystack = `${connection.id} ${connection.provider} ${connection.displayName} ${connection.secretEnvNames.join(' ')}`.toLowerCase();
  const purpose = haystack.includes('openai') ? 'openai'
    : haystack.includes('firecrawl') ? 'firecrawl'
      : haystack.includes('apify') ? 'apify'
        : haystack.includes('naver') ? 'naver'
          : haystack.includes('gws') || haystack.includes('google') ? 'google'
            : haystack.includes('ssh') ? 'ssh'
              : haystack.includes('aligo') ? 'aligo'
                : 'default';
  return adminText(`credentialConnections.purpose.${purpose}`);
}

function connectionPlainRisk(connection: CredentialAdminConnectionOverview['connections'][number]): string {
  return adminText(`credentialConnections.risk.${connection.riskLevel === 'high' ? 'high' : connection.riskLevel === 'medium' ? 'medium' : 'low'}`);
}

function connectionScopeExplanation(connection: CredentialAdminConnectionOverview['connections'][number]): string {
  if (connection.defaultOn) return adminText('credentialConnections.usageScope.allProjects');
  if (connection.stats.connectedProjects > 0) return adminText('credentialConnections.usageScope.projectCount', { count: connection.stats.connectedProjects });
  return adminText('credentialConnections.usageScope.none');
}

function plainConnectionStatus(status: string): string {
  const key = ({ inherited: 'inherited', connected: 'connected', blocked: 'blocked', needs_attention: 'needsAttention', disabled: 'disabled' } as const)[status as 'inherited'] || 'off';
  return adminText(`credentialConnections.status.${key}`);
}

function translateConnectionWarning(message: string): string {
  const inherited = message.match(/^(\d+) projects inherit this .* credential by default$/);
  if (inherited) return adminText('credentialConnections.warning.inherited', { count: Number(inherited[1]) });
  const disabled = message.match(/^(\d+) projects have policy rows for a disabled credential$/);
  if (disabled) return adminText('credentialConnections.warning.disabledPolicies', { count: Number(disabled[1]) });
  const sync = message.match(/^sync target (.+) is (.+)$/);
  if (sync) return adminText('credentialConnections.warning.syncTarget', { target: sync[1], status: sync[2] });
  if (message.includes('profile disabled')) return adminText('credentialConnections.warning.profileDisabled');
  if (message.includes('profile denied')) return adminText('credentialConnections.warning.profileDenied');
  return message;
}

function copyText(text: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard) void navigator.clipboard.writeText(text);
}

export function PersonalCredentialsPanel({ open, onClose, token }: PersonalCredentialsPanelProps) {
  if (!open) return null;
  return (
    <div data-testid="personal-credentials-panel" className="fixed inset-0 z-[200] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-surface-900 border border-surface-700 rounded-xl shadow-2xl w-full max-w-6xl max-h-[85vh] mx-4 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-800 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-primary-600/20 border border-primary-500/30 flex items-center justify-center">
              <svg className="w-4 h-4 text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <h2 className="text-[18px] font-bold text-gray-100">개인 크레덴셜</h2>
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-500 hover:text-gray-300 hover:bg-surface-800 rounded-lg transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <CredentialVaultManagement token={token} mode="personal" />
        </div>
      </div>
    </div>
  );
}

function CredentialVaultManagement({ token, mode }: { token?: string | null; mode: 'global' | 'personal' }) {
  const { t } = useTranslation('admin');
  const role = getCurrentRole() || 'member';
  const isAdmin = role === 'admin';
  const canManageGlobalCredentials = mode === 'global' && role === 'admin';
  const isPersonalCredentialMode = mode === 'personal';
  const confirm = useConfirm();
  const [credentials, setCredentials] = useState<WorkspaceCredential[]>([]);
  const [oauthProviders, setOAuthProviders] = useState<OAuthProviderConnection[]>([]);
  const [targets, setTargets] = useState<CredentialTargetSync[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [adminOverview, setAdminOverview] = useState<CredentialAdminConnectionOverview | null>(null);
  const [policies, setPolicies] = useState<CredentialProjectPolicy[]>([]);
  const [draftPolicies, setDraftPolicies] = useState<CredentialProjectPolicy[]>([]);
  const [accessSaving, setAccessSaving] = useState(false);
  const [bundleTypes, setBundleTypes] = useState<CredentialBundleType[]>([]);
  const [credentialTypes, setCredentialTypes] = useState<CredentialType[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState('');
  const [connectionMode, setConnectionMode] = useState<'none' | 'picker' | 'api_key_simple' | 'api_key' | 'oauth' | 'cloud' | 'ssh' | 'cli'>('none');
  const [showTargetForm, setShowTargetForm] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [personalSection, setPersonalSection] = useState<'connections' | 'projects'>('connections');
  const [accessView, setAccessView] = useState<'credential' | 'project'>('credential');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [connectionDetailTab, setConnectionDetailTab] = useState<'management' | 'agents' | 'advanced'>('management');
  const [connectionDisplayNameDraft, setConnectionDisplayNameDraft] = useState('');
  const [connectionLifecycleBusy, setConnectionLifecycleBusy] = useState(false);
  const [credentialRevealTarget, setCredentialRevealTarget] = useState<{ credentialId: string; displayName: string } | null>(null);
  const [credentialRevealValue, setCredentialRevealValue] = useState<string | null>(null);
  const [credentialSecureBusy, setCredentialSecureBusy] = useState(false);
  const [credentialInspectResults, setCredentialInspectResults] = useState<Record<string, { format: string; valid: boolean; lengthBucket: string; whitespace: string; jsonKeys?: string[]; sensitiveFieldCount?: number }>>({});
  const [credentialRotateTarget, setCredentialRotateTarget] = useState<{ credentialId: string; displayName: string } | null>(null);
  const [credentialRotateCandidate, setCredentialRotateCandidate] = useState('');
  const [connectionSavingKey, setConnectionSavingKey] = useState<string | null>(null);
  const [connectionProjectErrors, setConnectionProjectErrors] = useState<Record<string, string>>({});
  const [defaultSavingConnectionId, setDefaultSavingConnectionId] = useState<string | null>(null);
  const [expandedCredentialId, setExpandedCredentialId] = useState<string | null>(null);
  const connectionDetailTriggerRef = useRef<HTMLElement | null>(null);
  const addConnectionRef = useRef<HTMLElement | null>(null);
  const [projectAccessFilter, setProjectAccessFilter] = useState('');
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; summary: string }>>({});
  const [apiKeyForm, setApiKeyForm] = useState(apiKeyFormFromProvider('custom'));
  const [apiKeyProjectId, setApiKeyProjectId] = useState('');
  const [typedForm, setTypedForm] = useState({
    typeId: 'api_key',
    id: 'custom-api-key',
    displayName: '사용자 지정 API key',
    secretName: 'CUSTOM_API_KEY',
    defaultEnvName: 'CUSTOM_API_KEY',
    pathEnvName: '',
    filename: '',
    mode: '0600',
    projectId: '',
    values: {} as Record<string, string>,
  });
  const [bundleForm, setBundleForm] = useState({
    typeId: 'web-login',
    instanceId: 'web-login-main',
    displayName: 'Website login account',
    projectId: '',
    values: {} as Record<string, string>,
    envNames: {} as Record<string, string>,
  });
  const [targetForm, setTargetForm] = useState({
    credentialId: '',
    projectId: '',
    repo: '',
    secretName: '',
  });

  const headers = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [token]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [credRes, targetRes, projectsRes, policiesRes, bundleTypesRes, credentialTypesRes, overviewRes, oauthRes] = await Promise.all([
        fetch(`${API_BASE}/credential-vault/${isPersonalCredentialMode ? 'my/credentials' : 'credentials'}`, { headers: headers() }),
        isPersonalCredentialMode ? Promise.resolve(new Response(JSON.stringify({ targets: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : fetch(`${API_BASE}/credential-vault/targets`, { headers: headers() }),
        fetch(`${API_BASE}/projects`, { headers: headers() }),
        fetch(`${API_BASE}/credential-vault/${isPersonalCredentialMode ? 'my/project-policies' : 'project-policies'}`, { headers: headers() }),
        fetch(`${API_BASE}/credential-vault/bundle-types`, { headers: headers() }),
        fetch(`${API_BASE}/credential-vault/credential-types`, { headers: headers() }),
        isPersonalCredentialMode ? Promise.resolve(new Response(JSON.stringify(null), { status: 200, headers: { 'Content-Type': 'application/json' } })) : fetch(`${API_BASE}/credential-vault/admin-overview`, { headers: headers() }),
        fetch(`${API_BASE}/auth/oauth/providers`, { headers: headers() }),
      ]);
      if (credRes.ok) {
        const data = await credRes.json();
        setCredentials(data.credentials || []);
      } else {
        const data = await credRes.json().catch(() => ({}));
        setError(data.error || '연결 키 목록을 불러오지 못했습니다.');
      }
      if (targetRes.ok) {
        const data = await targetRes.json();
        setTargets(data.targets || []);
      }
      if (projectsRes.ok) {
        const data = await projectsRes.json();
        const nextProjects = Array.isArray(data) ? data : [];
        setProjects(nextProjects);
        setSelectedProjectId(current => current || nextProjects[0]?.id || '');
      }
      if (policiesRes.ok) {
        const data = await policiesRes.json();
        const nextPolicies = data.policies || [];
        setPolicies(nextPolicies);
        setDraftPolicies(nextPolicies);
      }
      if (bundleTypesRes.ok) {
        const data = await bundleTypesRes.json();
        const types = data.types || [];
        setBundleTypes(types);
        if (types.length > 0) {
          setBundleForm(f => {
            const current = types.find((t: CredentialBundleType) => t.id === f.typeId) || types[0];
            return {
              ...f,
              typeId: current.id,
              instanceId: f.instanceId || current.defaultInstanceId,
              displayName: f.displayName || current.defaultDisplayName,
            };
          });
        }
      }
      if (overviewRes.ok) {
        const data = await overviewRes.json();
        setAdminOverview(data);
      }
      if (oauthRes.ok) {
        const data = await oauthRes.json();
        setOAuthProviders(data.providers || []);
      }
      if (credentialTypesRes.ok) {
        const data = await credentialTypesRes.json();
        const types = data.types || [];
        setCredentialTypes(types);
        if (types.length > 0) {
          setTypedForm(f => {
            const current = types.find((t: CredentialType) => t.id === f.typeId) || types[0];
            return {
              ...f,
              typeId: current.id,
              id: f.id || current.defaultCredentialId,
              displayName: f.displayName || current.defaultDisplayName,
              secretName: f.secretName || current.defaultSecretName,
              defaultEnvName: f.defaultEnvName || current.defaultEnvName,
              pathEnvName: f.pathEnvName || current.defaultPathEnvName || '',
              filename: f.filename || current.defaultFilename || '',
              mode: f.mode || current.defaultMode || '0600',
            };
          });
        }
      }
    } catch (err: any) {
      setError(err.message || 'Credential Vault 요청에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }, [headers, isPersonalCredentialMode]);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => {
    if (isPersonalCredentialMode) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('oauth') !== 'google-organization') return;
    setStatusMessage(params.get('status') === 'success' ? '조직 Google Workspace Connection을 저장했습니다. 기존 Agent 권한은 유지됩니다.' : '조직 Google Workspace Connection을 저장하지 못했습니다. 다시 시도해 주세요.');
    params.delete('oauth');
    params.delete('status');
    params.delete('credentialId');
    params.delete('message');
    const query = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    void fetchAll();
  }, [fetchAll, isPersonalCredentialMode]);

  const openAddConnection = () => {
    setConnectionMode(current => current === 'none' ? 'picker' : 'none');
    if (connectionMode === 'none') {
      window.setTimeout(() => addConnectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
    }
  };

  const connectOrganizationGoogle = async (credentialId?: string) => {
    if (!isAdmin) return;
    setSaving(true);
    setError('');
    try {
      const query = credentialId ? `?mode=reauth&credentialId=${encodeURIComponent(credentialId)}` : '?mode=create';
      const res = await fetch(`${API_BASE}/auth/google/organization${query}`, { headers: headers() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.url !== 'string') throw new Error(data.error || '조직 Google 연결을 시작하지 못했습니다.');
      window.location.assign(data.url);
    } catch (err: any) {
      setError(err.message || '조직 Google 연결을 시작하지 못했습니다.');
      setSaving(false);
    }
  };

  const connectOAuthProvider = async (provider: OAuthProviderConnection) => {
    if (!provider.configured) {
      setError(`${provider.label} OAuth client가 서버에 설정되지 않았습니다.`);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch(provider.authPath, { headers: headers() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) throw new Error(data.error || 'OAuth 로그인 URL을 만들지 못했습니다.');
      window.location.href = data.url;
    } catch (err: any) {
      setError(err.message || 'OAuth 연결을 시작하지 못했습니다.');
      setSaving(false);
    }
  };

  const disconnectOAuthProvider = async (provider: OAuthProviderConnection) => {
    const ok = await confirm({
      title: `${provider.label} 연결 해제`,
      message: '개인 OAuth 토큰과 Runtime Box용 개인 CLI 설정을 함께 삭제합니다. 계속할까요?',
      confirmLabel: '연결 해제',
      danger: true,
    });
    if (!ok) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/auth/oauth/${encodeURIComponent(provider.id)}`, { method: 'DELETE', headers: headers() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'OAuth 연결 해제에 실패했습니다.');
      setStatusMessage(`${provider.label} 연결을 해제했습니다.`);
      await fetchAll();
    } catch (err: any) {
      setError(err.message || 'OAuth 연결 해제에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const saveApiKey = async () => {
    if (!canManageGlobalCredentials && !isPersonalCredentialMode) return;
    setSaving(true);
    setError('');
    setStatusMessage('');
    try {
      const normalizedForm = {
        ...apiKeyFormFromServiceName(apiKeyForm.provider || 'custom', apiKeyForm.secretValue),
        scope: apiKeyForm.scope || 'workspace',
      };
      if (!normalizedForm.secretValue?.trim()) {
        throw new Error('API key 값을 입력해야 합니다. 값은 저장 후 다시 표시하지 않습니다.');
      }
      setApiKeyForm(normalizedForm);
      const res = await fetch(`${API_BASE}/credential-vault/${isPersonalCredentialMode ? 'my/credentials/api-key' : 'credentials/api-key'}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(normalizedForm),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'API key 저장에 실패했습니다.');
      if (apiKeyProjectId) {
        const grantRes = await fetch(`${API_BASE}/credential-vault/${isPersonalCredentialMode ? 'my/projects' : 'projects'}/${encodeURIComponent(apiKeyProjectId)}/policies/${encodeURIComponent(normalizedForm.id)}`, {
          method: 'PUT',
          headers: headers(),
          body: JSON.stringify({ mode: 'allow', targetEnvName: normalizedForm.defaultEnvName }),
        });
        const grantData = await grantRes.json().catch(() => ({}));
        if (!grantRes.ok) throw new Error(grantData.error || 'API key는 저장됐지만 프로젝트 허용 설정에 실패했습니다.');
      }
      setApiKeyForm(f => ({ ...f, secretValue: '' }));
      setConnectionMode('none');
      setStatusMessage(`Credential 저장 완료: ${data.credential?.display_name || normalizedForm.displayName}.${apiKeyProjectId ? ' 선택한 프로젝트에서도 사용할 수 있습니다.' : ' 프로젝트 연결은 상세 보기에서 나중에 할 수 있습니다.'}`);
      await fetchAll();
    } catch (err: any) {
      setError(err.message || 'API key 저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const saveCredentialBundle = async () => {
    if (!isAdmin && !isPersonalCredentialMode) return;
    const selectedType = bundleTypes.find(t => t.id === bundleForm.typeId);
    setSaving(true);
    setError('');
    setStatusMessage('');
    try {
      if (!selectedType) throw new Error('Credential 종류를 선택해야 합니다.');
      for (const field of selectedType.fields) {
        if (field.required && !String(bundleForm.values[field.id] || '').trim()) throw new Error(`${field.label} 값을 입력해야 합니다.`);
      }
      const res = await fetch(`${API_BASE}/credential-vault/${isPersonalCredentialMode ? 'my/bundles' : 'bundles'}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(bundleForm),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Credential bundle 저장에 실패했습니다.');
      setConnectionMode('none');
      setBundleForm(f => ({ ...f, values: {} }));
      setStatusMessage(`Vault profile 저장 완료: ${data.profile?.display_name || bundleForm.displayName}.${bundleForm.projectId ? ' 선택한 프로젝트에서도 사용할 수 있습니다.' : ' 프로젝트 허용은 아직 설정하지 않았습니다.'}`);
      await fetchAll();
    } catch (err: any) {
      setError(err.message || 'Credential bundle 저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const saveTypedCredential = async () => {
    if (!canManageGlobalCredentials && !isPersonalCredentialMode) return;
    const selectedType = credentialTypes.find(t => t.id === typedForm.typeId);
    setSaving(true);
    setError('');
    setStatusMessage('');
    try {
      if (!selectedType) throw new Error('Credential 타입을 선택해야 합니다.');
      if (!typedForm.id || !typedForm.displayName || !typedForm.secretName || !typedForm.defaultEnvName) {
        throw new Error('표시 이름, Credential ID, Secret store name, Runtime env name을 모두 입력해야 합니다.');
      }
      if (selectedType.materialization === 'file' && !typedForm.pathEnvName) throw new Error('파일형 credential은 path env name이 필요합니다.');
      for (const field of selectedType.fields) {
        if (field.required && !String(typedForm.values[field.id] || '').trim()) throw new Error(`${field.label} 값을 입력해야 합니다.`);
      }
      const res = await fetch(`${API_BASE}/credential-vault/${isPersonalCredentialMode ? 'my/credentials/typed' : 'credentials/typed'}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(typedForm),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Typed credential 저장에 실패했습니다.');
      setConnectionMode('none');
      setTypedForm(f => ({ ...f, values: {} }));
      setStatusMessage(`Credential 저장 완료: ${data.credential?.display_name || typedForm.displayName}.${data.pathEnvName ? ` Runtime Box에서는 ${data.pathEnvName} 파일 경로로 제공됩니다.` : ''}`);
      await fetchAll();
    } catch (err: any) {
      setError(err.message || 'Typed credential 저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const addGitHubTarget = async () => {
    if (!isAdmin) return;
    setSaving(true);
    setError('');
    setStatusMessage('');
    try {
      if (!targetForm.credentialId || !targetForm.repo || !targetForm.secretName) throw new Error('연결 키, GitHub 저장소, Secret 이름을 모두 입력해야 합니다.');
      const res = await fetch(`${API_BASE}/credential-vault/targets/github-actions-secret`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(targetForm),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'GitHub Actions 연결 추가에 실패했습니다.');
      setShowTargetForm(false);
      setStatusMessage(`GitHub Actions 연결이 추가되었습니다 (#${data.target?.id ?? 'new'}).`);
      await fetchAll();
    } catch (err: any) {
      setError(err.message || 'GitHub Actions 연결 추가에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const refreshTargetStatus = async (targetId: number) => {
    setError('');
    setStatusMessage('');
    const res = await fetch(`${API_BASE}/credential-vault/targets/${targetId}/status`, { method: 'POST', headers: headers() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setError(data.error || '상태 확인에 실패했습니다.');
    else setStatusMessage(`연결 #${targetId} 상태: ${data.status === 'present' ? '정상' : data.status}`);
    await fetchAll();
  };

  const syncTarget = async (target: CredentialTargetSync) => {
    if (!isAdmin) return;
    const ok = await confirm({
      title: 'GitHub에 다시 쓰기',
      message: `${target.target_ref?.repo || 'GitHub 저장소'}의 ${target.target_ref?.secret_name || 'secret'} 값을 Tower에 저장된 값으로 덮어씁니다. Secret 값은 화면에 표시되지 않습니다.`,
      confirmLabel: '덮어쓰기',
      danger: true,
    });
    if (!ok) return;
    setError('');
    setStatusMessage('');
    const res = await fetch(`${API_BASE}/credential-vault/targets/${target.id}/sync`, { method: 'POST', headers: headers() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) setError(data.error || data.message || '동기화에 실패했습니다.');
    else setStatusMessage(`연결 #${target.id}을 GitHub에 다시 썼습니다.`);
    await fetchAll();
  };

  const testCredential = async (credential: WorkspaceCredential) => {
    if (!isAdmin) return;
    setError('');
    setStatusMessage('');
    setTestResults(prev => ({ ...prev, [credential.id]: { ok: false, summary: '테스트 중…' } }));
    const res = await fetch(`${API_BASE}/credential-vault/credentials/${encodeURIComponent(credential.id)}/test`, { method: 'POST', headers: headers() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const summary = data.error || 'Credential 테스트 API 호출 실패';
      setTestResults(prev => ({ ...prev, [credential.id]: { ok: false, summary } }));
      setError(summary);
      return;
    }
    const failed = Array.isArray(data.checks) ? data.checks.filter((c: any) => !c.ok).map((c: any) => c.name) : [];
    const checks = Array.isArray(data.checks) ? data.checks.length : 0;
    const summary = data.ok
      ? `통과 · ${data.materialization} · ${checks} checks`
      : `확인 필요 · ${failed.join(', ') || 'failed check'}`;
    setTestResults(prev => ({ ...prev, [credential.id]: { ok: Boolean(data.ok), summary } }));
    if (data.ok) setStatusMessage(`${credential.display_name || credential.id} 테스트 통과. Secret 값은 표시하지 않았습니다.`);
    else setError(`${credential.display_name || credential.id} 테스트 확인 필요: ${failed.join(', ') || 'failed check'}`);
  };

  const policyFrom = (source: CredentialProjectPolicy[], projectId: string, credentialId: string) => source.find(p => p.project_id === projectId && p.credential_id === credentialId);
  const policyFor = (projectId: string, credentialId: string) => policyFrom(draftPolicies, projectId, credentialId);
  const basePolicyFor = (projectId: string, credentialId: string) => policyFrom(policies, projectId, credentialId);
  const isCredentialAllowedForProject = (projectId: string, credential: WorkspaceCredential, source: CredentialProjectPolicy[] = draftPolicies) => {
    const policy = policyFrom(source, projectId, credential.id);
    if (policy?.mode === 'deny') return false;
    if (policy && ['allow', 'override', 'inherit'].includes(policy.mode)) return true;
    return credential.scope === 'workspace' || credential.scope === 'internal-default';
  };
  const accessLabelFor = (projectId: string, credential: WorkspaceCredential, source: CredentialProjectPolicy[] = draftPolicies) => {
    const policy = policyFrom(source, projectId, credential.id);
    if (policy?.mode === 'deny') return t('credentialConnections.access.denied');
    if (policy?.mode === 'allow') return t('credentialConnections.access.allowed');
    if (policy?.mode === 'override') return t('credentialConnections.access.allowedOverride');
    if (policy?.mode === 'inherit') return t('credentialConnections.access.allowedInherit');
    if (credential.scope === 'workspace' || credential.scope === 'internal-default') return t('credentialConnections.access.inherited');
    return t('credentialConnections.access.off');
  };
  const hasUnsavedAccessChange = (projectId: string, credentialId: string) => {
    const draft = policyFor(projectId, credentialId);
    const base = basePolicyFor(projectId, credentialId);
    if (!draft && !base) return false;
    return draft?.mode !== base?.mode || draft?.target_env_name !== base?.target_env_name;
  };
  const pendingAccessPolicies = draftPolicies.filter(policy => {
    const base = basePolicyFor(policy.project_id, policy.credential_id);
    return !base || base.mode !== policy.mode || base.target_env_name !== policy.target_env_name;
  });
  const hasPendingAccessChanges = pendingAccessPolicies.length > 0;

  const setCredentialProjectPolicy = (projectId: string, credential: WorkspaceCredential, allowed: boolean) => {
    if ((!canManageGlobalCredentials && !isPersonalCredentialMode) || !projectId) return;
    setError('');
    setStatusMessage('저장 전 변경사항이 있습니다. 저장을 눌러야 실제 Runtime Box 권한에 반영됩니다.');
    const updatedAt = new Date().toISOString();
    setDraftPolicies(prev => {
      const without = prev.filter(p => !(p.project_id === projectId && p.credential_id === credential.id));
      return [...without, {
        project_id: projectId,
        credential_id: credential.id,
        mode: allowed ? 'allow' : 'deny',
        target_env_name: credential.default_env_name || credential.secret_name,
        updated_at: updatedAt,
      }];
    });
  };

  const setProjectAllCredentials = (projectId: string, allowed: boolean) => {
    if (!projectId) return;
    credentials.forEach(credential => setCredentialProjectPolicy(projectId, credential, allowed));
  };

  const setCredentialAllProjects = (credential: WorkspaceCredential, allowed: boolean, scope: 'all' | 'filtered' = 'all') => {
    const targetProjects = scope === 'filtered' ? filteredProjectsForAccess : projects;
    targetProjects.forEach(project => setCredentialProjectPolicy(project.id, credential, allowed));
  };

  const selectedConnection = adminOverview?.connections.find(connection => connection.id === selectedConnectionId) || null;
  const closeConnectionDetail = useCallback(() => {
    setSelectedConnectionId(null);
    setCredentialRevealTarget(null);
    setCredentialRevealValue(null);
    setCredentialRotateTarget(null);
    setCredentialRotateCandidate('');
    window.setTimeout(() => connectionDetailTriggerRef.current?.focus(), 0);
  }, []);
  const openConnectionDetail = (connectionId: string) => {
    connectionDetailTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConnectionDisplayNameDraft(adminOverview?.connections.find(connection => connection.id === connectionId)?.displayName || '');
    setConnectionDetailTab('management');
    setSelectedConnectionId(connectionId);
  };

  useEffect(() => {
    if (!selectedConnectionId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeConnectionDetail();
    };
    const handleVisibility = () => {
      if (document.hidden) {
        setCredentialRevealValue(null);
        setCredentialRevealTarget(null);
        setCredentialRotateCandidate('');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [selectedConnectionId, closeConnectionDetail]);

  const updateConnectionDefault = async (connection: NonNullable<CredentialAdminConnectionOverview['connections'][number]>, enabled: boolean) => {
    if (!isAdmin) return;
    if (enabled && connection.riskLevel === 'high') {
      const ok = await confirm({
        title: 'High-risk 기본 연결 켜기',
        message: `이 연결에는 high-risk credential이 포함될 수 있습니다: ${connection.displayName}. 기본 연결로 켜면 여러 프로젝트에서 사용할 수 있습니다. 계속할까요?`,
        confirmLabel: '기본 연결 켜기',
        danger: true,
      });
      if (!ok) return;
    }
    setDefaultSavingConnectionId(connection.id);
    setError('');
    setStatusMessage('');
    try {
      const res = await fetch(`${API_BASE}/credential-vault/connection-defaults/${encodeURIComponent(connection.id)}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({
          enabled,
          defaultMode: connection.defaultScope && ['all_projects', 'new_projects', 'project_template'].includes(connection.defaultScope) ? connection.defaultScope : 'all_projects',
          riskAckRequired: connection.riskLevel === 'high',
          reason: enabled ? 'Admin enabled visible default connection' : 'Admin disabled visible default connection',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '기본 연결 상태 변경에 실패했습니다.');
      setStatusMessage(`${connection.displayName} 기본 연결을 ${enabled ? '켰습니다' : '껐습니다'}.`);
      await fetchAll();
    } catch (err: any) {
      setError(err.message || '기본 연결 상태 변경에 실패했습니다.');
    } finally {
      setDefaultSavingConnectionId(null);
    }
  };

  const handleConnectionPrimaryAction = (
    connection: NonNullable<CredentialAdminConnectionOverview['connections'][number]>,
    _action: ReturnType<typeof connectionPrimaryAction>,
  ) => {
    openConnectionDetail(connection.id);
  };

  const rotateCredential = async () => {
    if (!credentialRotateTarget || !credentialRotateCandidate) return;
    setCredentialSecureBusy(true);
    setError('');
    try {
      const previewRes = await fetch(`${API_BASE}/credential-vault/credentials/${encodeURIComponent(credentialRotateTarget.credentialId)}/rotate/preview`, {
        method: 'POST', headers: headers(), cache: 'no-store', body: JSON.stringify({ candidate: credentialRotateCandidate }),
      });
      const preview = await previewRes.json().catch(() => ({}));
      if (!previewRes.ok) throw new Error(preview.error || 'Credential 교체 preview에 실패했습니다.');
      const ok = await confirm({ title: 'Credential 교체', message: preview.impact, confirmLabel: '교체', danger: true });
      if (!ok) return;
      const applyRes = await fetch(`${API_BASE}/credential-vault/credentials/${encodeURIComponent(credentialRotateTarget.credentialId)}/rotate/apply`, {
        method: 'POST', headers: headers(), cache: 'no-store', body: JSON.stringify({ intentId: preview.intentId, proposalHash: preview.proposalHash, candidate: credentialRotateCandidate, confirmed: true }),
      });
      const result = await applyRes.json().catch(() => ({}));
      if (!applyRes.ok) throw new Error(result.error || 'Credential 교체에 실패했습니다.');
      setCredentialRotateCandidate('');
      setCredentialRotateTarget(null);
      setStatusMessage(`${credentialRotateTarget.displayName} Credential을 교체했습니다. 기존 프로젝트 연결은 유지됩니다.`);
      await fetchAll();
    } catch (err: any) {
      setError(err.message || 'Credential 교체에 실패했습니다.');
    } finally {
      setCredentialSecureBusy(false);
    }
  };

  const inspectCredential = async (credentialId: string) => {
    setCredentialSecureBusy(true);
    setError('');
    try {
      const response = await fetch(`${API_BASE}/credential-vault/credentials/${encodeURIComponent(credentialId)}/inspect`, {
        method: 'POST', headers: headers(), cache: 'no-store', body: JSON.stringify({ fieldId: 'secret_value', purpose: 'admin_structure_inspection' }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Credential 구조 검사에 실패했습니다.');
      setCredentialInspectResults(current => ({ ...current, [credentialId]: result }));
    } catch (err: any) {
      setError(err.message || 'Credential 구조 검사에 실패했습니다.');
    } finally {
      setCredentialSecureBusy(false);
    }
  };

  const revealCredential = async (credentialId: string, displayName: string) => {
    setCredentialSecureBusy(true);
    setError('');
    setStatusMessage('');
    setCredentialRevealValue(null);
    setCredentialRevealTarget({ credentialId, displayName });
    try {
      const response = await fetch(`${API_BASE}/credential-vault/credentials/${encodeURIComponent(credentialId)}/reveal`, {
        method: 'POST',
        headers: headers(),
        cache: 'no-store',
        body: JSON.stringify({ fieldId: 'secret_value', purpose: 'admin_session_reveal' }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Credential 원문을 불러오지 못했습니다.');
      setCredentialRevealValue(result.value);
      window.setTimeout(() => setCredentialRevealValue(null), Math.max(1, Number(result.expiresInSeconds || 30)) * 1000);
    } catch (err: any) {
      setCredentialRevealTarget(null);
      setError(err.message || 'Credential 원문을 불러오지 못했습니다.');
    } finally {
      setCredentialSecureBusy(false);
    }
  };

  const updateConnectionProject = async (connection: NonNullable<CredentialAdminConnectionOverview['connections'][number]>, projectId: string, mode: 'allow' | 'deny') => {
    if (!isAdmin) return;
    const action = mode === 'allow' ? 'connect' : 'disconnect';
    const projectName = projects.find(p => p.id === projectId)?.name || projectId;
    const key = `${connection.id}:${projectId}`;
    setConnectionSavingKey(key);
    setConnectionProjectErrors(current => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    setError('');
    setStatusMessage('');
    try {
      const previewRes = await fetch(`${API_BASE}/credential-vault/connections/${encodeURIComponent(connection.id)}/preview`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ action, projectId, riskLevel: connection.riskLevel }),
      });
      const preview = await previewRes.json().catch(() => ({}));
      if (!previewRes.ok) throw new Error(preview.error || 'Connection 변경 미리보기에 실패했습니다.');
      const approved = await confirm({
        title: action === 'connect' ? '서비스 연결 승인' : '서비스 연결 해제 승인',
        message: `${preview.impact}\n\n대상: ${connection.displayName} → ${projectName}\n주의도: ${connectionPlainRisk(connection)}\n만료: ${formatDateTime(preview.expiresAt)}\n\nSecret 값은 표시되거나 대화에 전달되지 않습니다.`,
        confirmLabel: action === 'connect' ? '연결 승인' : '해제 승인',
        danger: action === 'disconnect' || connection.riskLevel === 'high',
      });
      if (!approved) {
        setStatusMessage('Connection 변경을 취소했습니다.');
        return;
      }
      const applyRes = await fetch(`${API_BASE}/credential-vault/connections/${encodeURIComponent(connection.id)}/apply`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ intentId: preview.intentId, proposalHash: preview.proposalHash, confirmed: true }),
      });
      const applied = await applyRes.json().catch(() => ({}));
      if (!applyRes.ok) throw new Error(applied.error || 'Connection 프로젝트 권한 변경에 실패했습니다.');
      setStatusMessage(`${connection.displayName} 연결을 ${action === 'connect' ? '승인했습니다' : '해제했습니다'}.`);
      await fetchAll();
    } catch (err: any) {
      const message = err.message || 'Connection 프로젝트 권한 변경에 실패했습니다.';
      setConnectionProjectErrors(current => ({ ...current, [key]: message }));
      setError(message);
    } finally {
      setConnectionSavingKey(null);
    }
  };

  const updateOrganizationConnection = async (input: { displayName?: string; lifecycle?: 'disconnect' | 'restore' }) => {
    if (!isAdmin || !selectedConnection || selectedConnection.source !== 'credential' || !selectedConnection.credentialId) return;
    const disconnecting = input.lifecycle === 'disconnect';
    if (disconnecting) {
      const approved = await confirm({
        title: 'Connection을 안전하게 끊을까요?',
        message: `${selectedConnection.displayName}을 사용하는 Agent ${selectedConnection.stats.connectedProjects}개가 즉시 이 Connection을 사용할 수 없게 됩니다.\n\n암호화된 저장값과 Agent별 허용·차단 정책은 복구를 위해 보존됩니다.`,
        confirmLabel: '안전하게 연결 끊기',
        danger: true,
      });
      if (!approved) return;
    }
    setConnectionLifecycleBusy(true);
    setError('');
    try {
      const response = await fetch(`${API_BASE}/credential-vault/credentials/${encodeURIComponent(selectedConnection.credentialId)}/connection`, {
        method: 'PATCH', headers: headers(), body: JSON.stringify(input),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Connection 변경에 실패했습니다.');
      setStatusMessage(input.lifecycle === 'disconnect' ? 'Connection을 안전하게 끊었습니다. 저장값과 Agent 정책은 보존됩니다.' : input.lifecycle === 'restore' ? 'Connection을 기존 Agent 정책과 함께 복구했습니다.' : 'Connection 이름을 변경했습니다.');
      await fetchAll();
    } catch (err: any) {
      setError(err.message || 'Connection 변경에 실패했습니다.');
    } finally {
      setConnectionLifecycleBusy(false);
    }
  };

  const cancelAccessChanges = () => {
    setDraftPolicies(policies);
    setStatusMessage('저장 전 권한 변경을 취소했습니다.');
    setError('');
  };

  const saveAccessChanges = async () => {
    if ((!canManageGlobalCredentials && !isPersonalCredentialMode) || pendingAccessPolicies.length === 0) return;
    setAccessSaving(true);
    setError('');
    setStatusMessage('');
    try {
      for (const policy of pendingAccessPolicies) {
        const res = await fetch(`${API_BASE}/credential-vault/${isPersonalCredentialMode ? 'my/projects' : 'projects'}/${policy.project_id}/policies/${encodeURIComponent(policy.credential_id)}`, {
          method: 'PUT',
          headers: headers(),
          body: JSON.stringify({ mode: policy.mode, targetEnvName: policy.target_env_name }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `${policy.project_id}/${policy.credential_id} 정책 저장에 실패했습니다.`);
      }
      setPolicies(draftPolicies);
      setStatusMessage(`프로젝트 접근 권한 ${pendingAccessPolicies.length}개 변경을 저장했습니다.`);
    } catch (err: any) {
      setError(err.message || '프로젝트 접근 권한 저장에 실패했습니다.');
    } finally {
      setAccessSaving(false);
    }
  };

  const credentialAccessStats = (credential: WorkspaceCredential) => {
    let allowed = 0;
    let denied = 0;
    for (const project of projects) {
      if (isCredentialAllowedForProject(project.id, credential)) allowed += 1;
      if (policyFor(project.id, credential.id)?.mode === 'deny') denied += 1;
    }
    return { allowed, denied, total: projects.length };
  };

  const filteredProjectsForAccess = projects.filter(project => {
    const q = projectAccessFilter.trim().toLowerCase();
    return !q || project.name.toLowerCase().includes(q) || project.id.toLowerCase().includes(q);
  });
  const accessBadgeClass = (allowed: boolean, label: string) => {
    if (label === t('credentialConnections.access.denied')) return 'tone-danger';
    if (allowed) return 'tone-success';
    return 'tone-muted';
  };

  const inputClass = 'w-full bg-surface-950 border border-surface-700 rounded-md px-3 py-2 text-base text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-primary-500/60';
  const labelClass = 'block text-[13px] uppercase tracking-wider text-gray-500 mb-1.5';
  const selectedBundleType = bundleTypes.find(t => t.id === bundleForm.typeId) || bundleTypes[0];
  const selectedCredentialType = credentialTypes.find(t => t.id === typedForm.typeId) || credentialTypes[0];
  const applyCredentialTypeDefaults = (next: CredentialType) => {
    setTypedForm({
      typeId: next.id,
      id: next.defaultCredentialId,
      displayName: next.defaultDisplayName,
      secretName: next.defaultSecretName,
      defaultEnvName: next.defaultEnvName,
      pathEnvName: next.defaultPathEnvName || '',
      filename: next.defaultFilename || '',
      mode: next.defaultMode || '0600',
      projectId: '',
      values: {},
    });
  };
  const normalCredentials = credentials.filter(c => credentialHealth(c, targets).label === 'Vault 저장됨').length;
  const warningCredentials = credentials.filter(c => ['동기화 확인 필요', '동기화 오류'].includes(credentialHealth(c, targets).label)).length;
  const staleTargets = targets.filter(t => t.last_status === 'missing' || t.last_status === 'error' || t.last_error).length;
  const primaryOAuthProvider = oauthProviders.find(provider => provider.id === 'google') ?? oauthProviders[0];
  const aiCredentialPrompt = isPersonalCredentialMode
    ? `내 외부 서비스 연결 상태를 쉬운 말로 설명해줘.\n서비스별로 지금 사용할 수 있는지, 어떤 프로젝트에서 쓸 수 있는지, 다음 행동 하나를 알려줘.\nsecret, token, env 이름, 파일 경로는 출력하지 마.`
    : `이 Tower의 외부 서비스 연결 상태를 쉬운 말로 설명해줘.\n서비스별로 프로젝트 연결과 실제 Provider 사용 가능 여부를 구분하고, 조치가 필요하면 다음 행동 하나를 알려줘.\npresent만으로 성공 판정하지 말고 secret, token, env 이름, 파일 경로는 출력하지 마.`;
  const diagnosticCopyText = [
    error ? `오류: ${error}` : '',
    statusMessage ? `상태: ${statusMessage}` : '',
    adminOverview ? `요약: 연결 ${adminOverview.summary.connections}개, 기본 연결 ${adminOverview.summary.defaultConnections}개, 확인 필요 ${adminOverview.summary.needsAttention}개` : `개인 연결 ${credentials.length}개`,
    'AI에게 요청: 서비스별로 실제 사용 가능한지와 다음 행동 하나를 쉬운 말로 알려줘. secret, token, env 이름, 파일 경로는 출력하지 마.',
  ].filter(Boolean).join('\n');
  const addCredentialPrompt = isPersonalCredentialMode
    ? `내 개인 로그인/API 키를 Credential Vault에 저장하고 특정 프로젝트에서만 쓰고 싶어.\nsecret 값은 내가 안전 입력으로 넣을게. 저장 후 Runtime Box에서는 값 말고 present/missing만 확인해줘.`
    : `<자체 호스팅 서버 이름>에 <서비스명> API 키를 Credential Vault로 추가하고 싶어.\n전체 프로젝트 기본 연결로 둘지, 특정 프로젝트에만 허용할지 판단해줘.\nsecret 값은 내가 안전 입력으로 넣을게. 적용 후 Runtime Box presence smoke까지 확인해줘.`;

  if (loading) return <div className="text-gray-500 text-base py-8 text-center">외부 연결 상태를 불러오는 중…</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div>
          <div className="text-[13px] font-semibold text-primary-300 uppercase tracking-[0.2em] mb-2">{isPersonalCredentialMode ? '내 연결' : '외부 서비스 연결'}</div>
          <h3 className="text-2xl font-semibold text-gray-100">{isPersonalCredentialMode ? '내 외부 서비스' : 'Connections'}</h3>
          <p className="text-base text-gray-500 mt-2 max-w-2xl">
            {isPersonalCredentialMode
              ? '내가 사용하는 외부 계정을 연결하고, 어떤 프로젝트의 AI가 내 요청을 처리할 때 사용할 수 있는지 관리합니다. 다른 사용자가 같은 프로젝트의 AI 팀원을 사용해도 내 Credential은 전달되지 않습니다.'
              : 'Tower와 프로젝트가 사용하는 외부 서비스를 한곳에서 연결하고 상태를 확인합니다. 실제 인증이 확인된 연결만 사용 가능으로 표시합니다.'}
          </p>
          <p className="text-[14px] text-gray-500 mt-2 max-w-3xl">
            {isPersonalCredentialMode ? 'API 키와 로그인 값은 화면이나 대화에 표시되지 않습니다. 내가 시작한 실행에서만 허용한 프로젝트의 팀원·Helper와 Primary AI 팀원과 Helper Agent가 사용할 수 있습니다. 기술 설정은 필요한 경우에만 고급 관리에서 확인할 수 있습니다.' : '서비스명, 용도, 현재 상태와 다음 행동만 확인하세요. Credential ID와 Runtime env 같은 기술 설정은 고급 관리에 숨겨져 있습니다.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          {isPersonalCredentialMode ? (
            <>
              {primaryOAuthProvider && (
                <button
                  disabled={saving}
                  onClick={() => connectOAuthProvider(primaryOAuthProvider)}
                  aria-disabled={!primaryOAuthProvider.configured}
                  title={!primaryOAuthProvider.configured ? '이 Tower 서버에 Google OAuth 설정이 필요합니다.' : undefined}
                  className="px-3 py-2 text-base rounded-lg bg-primary-600 text-white hover:bg-primary-500 transition-colors"
                >
                  {primaryOAuthProvider.configured
                    ? primaryOAuthProvider.status === 'not_connected' ? 'Google 계정 연결' : primaryOAuthProvider.status === 'reauth_required' ? 'Google 다시 로그인' : 'Google 계정 변경'
                    : 'Google 연결 설정 필요'}
                </button>
              )}
              <button
                onClick={() => {
                  setConnectionMode(current => current === 'api_key_simple' ? 'none' : 'api_key_simple');
                  window.setTimeout(() => addConnectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
                }}
                className="px-3 py-2 text-base rounded-lg border border-surface-700 text-gray-200 hover:bg-surface-800 transition-colors"
              >
                {connectionMode === 'api_key_simple' ? 'API 키 추가 닫기' : '+ API 키 추가'}
              </button>
            </>
          ) : isAdmin && (
            <button onClick={openAddConnection} className="px-3 py-2 text-base rounded-lg bg-primary-600 text-white hover:bg-primary-500 transition-colors">
              {connectionMode === 'none' ? '+ 연결 추가' : '추가 닫기'}
            </button>
          )}
          <button onClick={fetchAll} className="px-3 py-2 text-base rounded-lg border border-surface-700 text-gray-300 hover:text-gray-100 hover:bg-surface-800 transition-colors">
            상태 새로고침
          </button>
        </div>
      </div>

      {isPersonalCredentialMode && (
        <div className="inline-flex w-full sm:w-auto rounded-lg border border-surface-700 bg-surface-950/50 p-1" role="tablist" aria-label="개인 연결 관리 영역">
          <button
            type="button"
            role="tab"
            aria-selected={personalSection === 'connections'}
            onClick={() => setPersonalSection('connections')}
            className={`flex-1 sm:flex-none rounded-md px-4 py-2 text-[14px] font-semibold transition-colors ${personalSection === 'connections' ? 'bg-surface-700 text-gray-100' : 'text-gray-500 hover:text-gray-300'}`}
          >
            연결과 상태
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={personalSection === 'projects'}
            onClick={() => setPersonalSection('projects')}
            className={`flex-1 sm:flex-none rounded-md px-4 py-2 text-[14px] font-semibold transition-colors ${personalSection === 'projects' ? 'bg-surface-700 text-gray-100' : 'text-gray-500 hover:text-gray-300'}`}
          >
            내 프로젝트 권한{pendingAccessPolicies.length > 0 ? ` · ${pendingAccessPolicies.length}` : ''}
          </button>
        </div>
      )}

      {error && (
        <div className="tone-card tone-danger rounded-lg px-4 py-3 text-base space-y-2">
          <div>{error}</div>
          <div className="text-[14px] opacity-80">목록이 비어 보이거나 의미를 모르겠다면 아래 프롬프트를 운영자 AI에게 보내 상태를 먼저 진단하세요.</div>
        </div>
      )}
      {statusMessage && <div className="tone-card tone-success rounded-lg px-4 py-3 text-base">{statusMessage}</div>}

      {isPersonalCredentialMode && personalSection === 'connections' && oauthProviders.length > 0 && (
        <section className="rounded-xl border border-surface-700 bg-surface-950/30 overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-800">
            <h4 className="text-base font-semibold text-gray-100">로그인 계정</h4>
            <p className="text-[14px] text-gray-500 mt-1">Google 메일·캘린더·드라이브에 사용할 내 계정입니다. 한 번 연결하면 Tower가 필요할 때 안전하게 불러옵니다.</p>
          </div>
          <div className="divide-y divide-surface-800">
            {oauthProviders.map(provider => (
              <div key={provider.id} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold text-gray-100">{provider.label}</span>
                    <span className={`tone-pill px-2 py-0.5 text-[12px] ${provider.status === 'connected' ? 'tone-success' : provider.status === 'reauth_required' ? 'tone-warning' : 'tone-muted'}`}>
                      {provider.status === 'connected' ? '연결됨' : provider.status === 'reauth_required' ? '다시 로그인 필요' : '연결 안 됨'}
                    </span>
                  </div>
                  <div className="text-[14px] text-gray-500 mt-1">
                    {!provider.configured
                      ? '이 Tower 서버의 Google OAuth 설정이 아직 완료되지 않았습니다. 운영자가 OAuth client와 이 도메인의 callback URI를 등록해야 합니다.'
                      : provider.nickname || (provider.status === 'reauth_required' ? '저장된 로그인 정보가 만료되었거나 Google에서 폐기되었습니다.' : provider.description)}
                  </div>
                  {provider.statusReason && provider.status === 'reauth_required' && <div className="mt-1 text-[12px] text-amber-300/80">실제 토큰 갱신 확인 실패 · 다시 연결하면 교체됩니다.</div>}
                </div>
                <div className="flex flex-wrap gap-2 shrink-0">
                  <button disabled={saving} aria-disabled={!provider.configured} onClick={() => connectOAuthProvider(provider)} className="px-3 py-2 text-[14px] rounded-md bg-primary-600 text-white hover:bg-primary-500 transition-colors">
                    {provider.configured ? provider.status === 'not_connected' ? '계정 연결' : provider.status === 'reauth_required' ? '다시 로그인' : '계정 변경' : '설정 방법 확인'}
                  </button>
                  {provider.status !== 'not_connected' && <button disabled={saving} onClick={() => disconnectOAuthProvider(provider)} className="px-3 py-2 text-[14px] rounded-md border border-red-500/30 text-red-300 hover:bg-red-500/10 disabled:opacity-40 transition-colors">연결 해제</button>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {!isPersonalCredentialMode ? (
        <section className="rounded-xl border border-primary-500/25 bg-primary-500/5 p-4 space-y-3">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
            <div>
              <h4 className="text-base font-semibold text-gray-100">AI에게 연결 상태 물어보기</h4>
              <p className="text-[14px] text-gray-500 mt-1 max-w-3xl">서비스가 실제로 사용 가능한지, 문제가 있다면 무엇을 해야 하는지 같은 Connection 상태를 기준으로 설명합니다. 비밀값이나 기술 이름은 대화에 포함하지 않습니다.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => copyText(aiCredentialPrompt)} className="px-3 py-1.5 text-[14px] rounded-md border border-primary-500/40 text-primary-300 hover:bg-primary-500/10 transition-colors">진단 프롬프트 복사</button>
              <button onClick={() => copyText(diagnosticCopyText)} className="px-3 py-1.5 text-[14px] rounded-md border border-surface-700 text-gray-300 hover:bg-surface-800 transition-colors">화면 상태 전체 복사</button>
            </div>
          </div>
          <pre className="whitespace-pre-wrap rounded-lg border border-surface-800 bg-surface-950/70 p-3 text-[14px] text-gray-300">{aiCredentialPrompt}</pre>
          <details className="text-[14px] text-gray-500">
            <summary className="cursor-pointer text-gray-400">새 API 키를 추가할 때 쓸 프롬프트</summary>
            <div className="mt-2 flex flex-col gap-2">
              <pre className="whitespace-pre-wrap rounded-lg border border-surface-800 bg-surface-950/70 p-3 text-[14px] text-gray-300">{addCredentialPrompt}</pre>
              <button onClick={() => copyText(addCredentialPrompt)} className="self-start px-3 py-1.5 text-[14px] rounded-md border border-surface-700 text-gray-300 hover:bg-surface-800 transition-colors">추가 프롬프트 복사</button>
            </div>
          </details>
        </section>
      ) : personalSection === 'connections' ? (
        <details className="rounded-xl border border-surface-800 bg-surface-950/30 px-4 py-3 text-[14px] text-gray-500">
          <summary className="cursor-pointer text-gray-300 font-medium">AI에게 연결 상태 물어보기</summary>
          <div className="mt-3 space-y-3">
            <p>아래 내용에는 secret 값이 포함되지 않습니다.</p>
            <pre className="whitespace-pre-wrap rounded-lg border border-surface-800 bg-surface-950/70 p-3 text-[14px] text-gray-300">{aiCredentialPrompt}</pre>
            <button onClick={() => copyText(aiCredentialPrompt)} className="px-3 py-1.5 rounded-md border border-primary-500/40 text-primary-300 hover:bg-primary-500/10 transition-colors">진단 문장 복사</button>
          </div>
        </details>
      ) : null}

      {(!isPersonalCredentialMode || personalSection === 'connections') && <div className="rounded-xl border border-surface-800 bg-surface-950/40 px-4 py-3 text-[14px] text-gray-400 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2">
        <div>
          {isPersonalCredentialMode
            ? `내 연결 ${credentials.length}개 · 프로젝트 변경 ${pendingAccessPolicies.length}개`
            : `등록된 연결 ${adminOverview?.summary.connections ?? credentials.length}개 · 모든 프로젝트 기본 연결 ${adminOverview?.summary.defaultConnections ?? 0}개`}
          {!isPersonalCredentialMode && ((adminOverview?.summary.needsAttention ?? warningCredentials) > 0 ? ` · 실제 점검 필요 ${adminOverview?.summary.needsAttention ?? warningCredentials}개` : ' · 지금 조치할 항목 없음')}
        </div>
        <div className="text-gray-600">{isPersonalCredentialMode ? '값 비공개 · 내 프로젝트에만 연결' : `외부 동기화 대상 ${targets.length}개${staleTargets ? ` · 문제 ${staleTargets}개` : ''}`}</div>
      </div>}

      {adminOverview && !isPersonalCredentialMode && (
        <section className="rounded-xl border border-surface-700 bg-surface-950/30 overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-800 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2">
            <div>
              <h4 className="text-base font-semibold text-gray-200">서비스 연결</h4>
              <p className="text-[14px] text-gray-500 mt-1">서비스가 어디에서 쓰이고 실제로 사용할 수 있는지 확인합니다. 기술 설정은 고급 관리에서만 다룹니다.</p>
            </div>
            <div className="text-[13px] text-gray-500">
              연결됨 {adminOverview.connections.filter(c => c.stats.connectedProjects > 0).length}개 · 미연결 {adminOverview.connections.filter(c => c.stats.connectedProjects === 0).length}개
            </div>
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[920px]">
              <thead>
                <tr className="bg-surface-800/60 text-[13px] text-surface-500 uppercase tracking-wider">
                  <th className="px-4 py-2.5 text-left font-semibold">서비스</th>
                  <th className="px-4 py-2.5 text-left font-semibold">상태</th>
                  <th className="px-4 py-2.5 text-left font-semibold">프로젝트</th>
                  <th className="px-4 py-2.5 text-left font-semibold">실제 인증</th>
                  <th className="w-36 px-4 py-2.5 text-right font-semibold">다음 행동</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-800/60">
                {adminOverview.connections.map(connection => {
                  const readiness = connectionReadinessStyle(connection);
                  const primaryAction = connectionPrimaryAction(connection);
                  return (
                    <tr key={connection.id} className="hover:bg-surface-800/30 transition-colors">
                      <td className="px-4 py-3 align-top">
                        <div className="max-w-[320px] truncate text-base font-semibold text-surface-100" title={connection.displayName}>{connection.displayName}</div>
                        <div className="mt-1 max-w-[360px] text-[13px] text-surface-500">{connectionPurpose(connection)}</div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <span className={`tone-pill inline-flex whitespace-nowrap px-2 py-0.5 text-[13px] ${readiness.className}`}>{readiness.label}</span>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="text-[14px] font-medium text-surface-300">{connection.defaultOn ? '전체 프로젝트' : connection.stats.connectedProjects > 0 ? `${connection.stats.connectedProjects}개 프로젝트` : '미연결'}</div>
                        <div className="mt-1 text-[13px] text-surface-500">{connection.defaultOn ? '기본 사용' : connection.stats.connectedProjects > 0 ? `전체 ${connection.stats.totalProjects}개 중 일부` : '사용 중인 프로젝트 없음'}</div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className={`text-[14px] font-medium ${connection.readiness.providerHealth.status === 'ready' ? 'tone-success tone-text' : 'text-surface-400'}`}>
                          {connection.readiness.providerHealth.status === 'ready' ? '확인됨' : '확인 안 됨'}
                        </div>
                        <div className="mt-1 text-[13px] text-surface-500">{connection.readiness.providerHealth.reasonCode || (connection.readiness.providerHealth.checkedAt ? `마지막 확인 ${new Date(connection.readiness.providerHealth.checkedAt).toLocaleString()}` : '아직 실제 인증을 확인하지 않았습니다.')}</div>
                      </td>
                      <td className="px-4 py-3 text-right align-top">
                        <button
                          type="button"
                          onClick={() => handleConnectionPrimaryAction(connection, primaryAction)}
                          className="min-h-10 whitespace-nowrap rounded-md bg-primary-600 px-3 py-2 text-[14px] text-white transition-colors hover:bg-primary-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
                        >
                          {primaryAction.label}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="divide-y divide-surface-800/60 md:hidden">
            {adminOverview.connections.map(connection => {
              const readiness = connectionReadinessStyle(connection);
              const primaryAction = connectionPrimaryAction(connection);
              return (
                <div key={connection.id} className="space-y-3 px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-base font-semibold text-surface-100" title={connection.displayName}>{connection.displayName}</div>
                      <div className="mt-1 text-[13px] text-surface-500">{connectionPurpose(connection)}</div>
                    </div>
                    <span className={`tone-pill shrink-0 whitespace-nowrap px-2 py-0.5 text-[13px] ${readiness.className}`}>{readiness.label}</span>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
                    <div>
                      <dt className="text-surface-500">프로젝트</dt>
                      <dd className="mt-0.5 text-[14px] font-medium text-surface-300">{connection.defaultOn ? '전체 프로젝트' : connection.stats.connectedProjects > 0 ? `${connection.stats.connectedProjects}개 사용` : '미연결'}</dd>
                    </div>
                    <div>
                      <dt className="text-surface-500">실제 인증</dt>
                      <dd className={`mt-0.5 text-[14px] font-medium ${connection.readiness.providerHealth.status === 'ready' ? 'tone-success tone-text' : 'text-surface-400'}`}>{connection.readiness.providerHealth.status === 'ready' ? '확인됨' : '확인 안 됨'}</dd>
                    </div>
                  </dl>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleConnectionPrimaryAction(connection, primaryAction)}
                      className="min-h-11 flex-1 rounded-md bg-primary-600 px-3 py-2 text-[14px] text-white transition-colors hover:bg-primary-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
                    >
                      {primaryAction.label}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {selectedConnection && isAdmin && (
        <div className="fixed inset-0 z-50 flex justify-end" role="presentation">
          <button
            type="button"
            aria-label="Connection 관리 닫기"
            className="absolute inset-0 bg-surface-950/70"
            onClick={closeConnectionDetail}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-labelledby="connection-detail-title"
            className="relative flex h-full w-full flex-col border-l border-surface-700 bg-surface-950 shadow-2xl md:max-w-[560px]"
          >
            <header className="flex items-start justify-between gap-4 border-b border-surface-800 px-4 py-4 md:px-5">
              <div className="min-w-0">
                <div className="text-[13px] font-semibold uppercase tracking-[0.16em] text-primary-300">Connection 관리</div>
                <h4 id="connection-detail-title" className="mt-1 truncate text-xl font-semibold text-surface-100">{selectedConnection.displayName}</h4>
                <p className="mt-1 text-[14px] leading-relaxed text-surface-400">{connectionPurpose(selectedConnection)}</p>
              </div>
              <button type="button" onClick={closeConnectionDetail} className="min-h-10 shrink-0 rounded-md border border-surface-700 px-3 text-[14px] text-surface-300 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">닫기</button>
            </header>

            <nav aria-label="Connection 관리 영역" className="flex overflow-x-auto border-b border-surface-800 px-2 md:px-3">
              {([
                ['management', 'Connection 관리'],
                ['agents', '허용 Agent'],
                ['advanced', '고급'],
              ] as const).map(([tab, label]) => (
                <button
                  key={tab}
                  type="button"
                  aria-selected={connectionDetailTab === tab}
                  onClick={() => setConnectionDetailTab(tab)}
                  className={`min-h-11 whitespace-nowrap border-b-2 px-3 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${connectionDetailTab === tab ? 'border-primary-400 text-primary-300' : 'border-transparent text-surface-400 hover:text-surface-200'}`}
                >{label}</button>
              ))}
            </nav>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-5">
              {connectionDetailTab === 'management' && (
                <div className="space-y-5">
                  <section>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`tone-pill px-2 py-1 text-[13px] ${connectionReadinessStyle(selectedConnection).className}`}>{connectionReadinessStyle(selectedConnection).label}</span>
                      <span className={`tone-pill px-2 py-1 text-[13px] ${riskStyle(selectedConnection.riskLevel)}`}>{connectionPlainRisk(selectedConnection)}</span>
                    </div>
                    <p className="mt-3 text-[14px] leading-relaxed text-surface-300">{connectionReadinessStyle(selectedConnection).description}</p>
                  </section>
                  <dl className="divide-y divide-surface-800 border-y border-surface-800">
                    <div className="flex justify-between gap-4 py-3"><dt className="text-[14px] text-surface-400">프로젝트 연결</dt><dd className="text-right text-[14px] font-medium text-surface-200">{selectedConnection.stats.connectedProjects}개 사용 중</dd></div>
                    <div className="flex justify-between gap-4 py-3"><dt className="text-[14px] text-surface-400">실제 인증</dt><dd className="text-right text-[14px] font-medium text-surface-200">{selectedConnection.readiness.providerHealth.status === 'ready' ? '확인됨' : selectedConnection.readiness.providerHealth.status === 'unsupported' ? '자동 확인 미지원' : '확인 필요'}</dd></div>
                    <div className="flex justify-between gap-4 py-3"><dt className="text-[14px] text-surface-400">차단·점검</dt><dd className="text-right text-[14px] font-medium text-surface-200">차단 {selectedConnection.stats.blockedProjects} · 점검 {selectedConnection.stats.attentionProjects}</dd></div>
                  </dl>
                  {selectedConnection.source === 'credential' && <section className="space-y-3 rounded-lg border border-surface-700 bg-surface-900 p-4"><div><h5 className="text-base font-semibold text-surface-100">기본 관리</h5><p className="mt-1 text-[14px] text-surface-400">이름 변경, 계정 다시 연결, 안전한 연결 끊기와 복구를 관리합니다.</p></div><label className="block text-[13px] font-medium text-surface-400">Connection 이름<input value={connectionDisplayNameDraft} onChange={event => setConnectionDisplayNameDraft(event.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-surface-700 bg-surface-950 px-3 text-[14px] text-surface-100 outline-none focus-visible:ring-2 focus-visible:ring-primary-400" /></label><div className="flex flex-wrap gap-2"><button type="button" disabled={connectionLifecycleBusy || connectionDisplayNameDraft.trim() === selectedConnection.displayName || connectionDisplayNameDraft.trim().length < 2} onClick={() => void updateOrganizationConnection({ displayName: connectionDisplayNameDraft.trim() })} className="min-h-10 rounded-md border border-surface-700 px-3 text-[13px] font-medium text-surface-200 hover:bg-surface-800 disabled:cursor-not-allowed disabled:text-surface-600">이름 저장</button>{selectedConnection.credentials.some(credential => credential.allowedActions?.replacementAction === 'reauth' && credential.provider === 'google') && <button type="button" disabled={saving || !selectedConnection.enabled} onClick={() => void connectOrganizationGoogle(selectedConnection.credentialId)} className="tone-accent tone-action min-h-10 rounded-md px-3 text-[13px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:bg-surface-800 disabled:text-surface-500">Google 계정 다시 연결</button>}{selectedConnection.enabled ? <button type="button" disabled={connectionLifecycleBusy} onClick={() => void updateOrganizationConnection({ lifecycle: 'disconnect' })} className="tone-action tone-danger min-h-10 rounded-md px-3 text-[13px] font-semibold disabled:cursor-not-allowed">안전하게 연결 끊기</button> : <button type="button" disabled={connectionLifecycleBusy} onClick={() => void updateOrganizationConnection({ lifecycle: 'restore' })} className="tone-action tone-success min-h-10 rounded-md px-3 text-[13px] font-semibold disabled:cursor-not-allowed">연결 복구</button>}</div></section>}
                </div>
              )}

              {connectionDetailTab === 'advanced' && (
                <div className="space-y-4">
                  <div><h5 className="text-base font-semibold text-surface-100">고급 Credential 관리</h5><p className="mt-1 text-[14px] text-surface-400">원문·구조·기술 이름처럼 일반 연결 관리에는 필요하지 않은 운영자 기능입니다.</p></div>
                  <div className="divide-y divide-surface-800 border-y border-surface-800">
                    {selectedConnection.credentials.map(credential => (
                      <div key={credential.id} className="py-4">
                        <div className="flex items-start justify-between gap-3"><div className="text-[14px] font-medium text-surface-200">{credential.displayName}</div><span className={`tone-pill px-2 py-0.5 text-[12px] ${credential.enabled ? 'tone-success' : 'tone-muted'}`}>{credential.enabled ? '저장됨' : '사용 중지'}</span></div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {credential.allowedActions?.reveal !== false && <button type="button" disabled={credentialSecureBusy} onClick={() => void revealCredential(credential.id, credential.displayName)} className="min-h-10 rounded-md border border-surface-700 px-3 text-[13px] text-surface-200 hover:bg-surface-800 disabled:cursor-not-allowed disabled:text-surface-600">원문 보기</button>}
                          {credential.allowedActions?.replacementAction === 'rotate' && <button type="button" onClick={() => { setCredentialRotateTarget({ credentialId: credential.id, displayName: credential.displayName }); setCredentialRotateCandidate(''); }} className="min-h-10 rounded-md border border-surface-700 px-3 text-[13px] text-surface-200 hover:bg-surface-800">수정하기</button>}
                          {credential.allowedActions?.replacementAction === 'reauth' && credential.provider === 'google' && <button type="button" disabled={saving} onClick={() => void connectOrganizationGoogle(credential.id)} className="tone-accent tone-action min-h-10 rounded-md px-3 text-[13px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:bg-surface-800 disabled:text-surface-500">조직 계정 재인증</button>}
                          <button type="button" disabled={credentialSecureBusy} onClick={() => inspectCredential(credential.id)} className="min-h-10 rounded-md border border-surface-700 px-3 text-[13px] text-surface-200 hover:bg-surface-800 disabled:cursor-not-allowed disabled:text-surface-600">구조 보기</button>
                        </div>
                        {credentialRevealTarget?.credentialId === credential.id && credentialRevealValue !== null && <div className="mt-3 rounded-md border border-surface-700 bg-surface-950 p-3"><div className="flex items-center justify-between gap-3"><span className="text-[12px] font-medium text-surface-400">원문 · 30초 후 자동 마스킹</span><button type="button" onClick={() => { setCredentialRevealValue(null); setCredentialRevealTarget(null); }} className="text-[13px] text-primary-300 hover:text-primary-200">지금 가리기</button></div><div className="mt-2 break-all font-mono text-[13px] text-surface-100">{credentialRevealValue}</div></div>}
                        {credential.allowedActions?.reason === 'oauth_token' && <p className="mt-2 text-[13px] text-surface-400">OAuth token은 원문을 표시하지 않습니다. 문제가 있으면 다시 연결하세요.</p>}
                        {credential.allowedActions?.reason === 'ssh_private_key' && <p className="mt-2 text-[13px] text-surface-400">SSH private key는 원문을 표시하지 않습니다. 확인이 필요하면 수정 흐름을 사용하세요.</p>}
                        {credential.allowedActions?.reason === 'structured_credential' && <p className="mt-2 text-[13px] text-surface-400">구조화 Credential은 민감 필드를 제외한 구조만 검사할 수 있습니다.</p>}
                        {credentialInspectResults[credential.id] && <div className="mt-3 rounded-md bg-surface-900 p-3 text-[13px] text-surface-300">형식 {credentialInspectResults[credential.id].format} · {credentialInspectResults[credential.id].valid ? '유효' : '확인 필요'} · 길이 {credentialInspectResults[credential.id].lengthBucket} · 공백 {credentialInspectResults[credential.id].whitespace}</div>}
                        <details className="mt-2 text-[13px] text-surface-400"><summary className="cursor-pointer">기술 이름 보기</summary><div className="mt-2 break-all font-mono text-surface-300">{credential.id} · {credential.envName}</div></details>
                      </div>
                    ))}
                  </div>
                  {credentialRotateTarget && (
                    <section className="rounded-lg border border-surface-700 bg-surface-900 p-4" aria-label="Credential 교체">
                      <div className="flex items-start justify-between gap-3"><div><h6 className="text-[14px] font-semibold text-surface-100">{credentialRotateTarget.displayName} 교체</h6><p className="mt-1 text-[13px] text-surface-400">기존 Credential ID와 프로젝트 연결을 유지하고 저장값만 교체합니다.</p></div><button type="button" onClick={() => { setCredentialRotateTarget(null); setCredentialRotateCandidate(''); }} className="text-[13px] text-surface-400 hover:text-surface-200">취소</button></div>
                      <input type="password" autoComplete="off" value={credentialRotateCandidate} onChange={event => setCredentialRotateCandidate(event.target.value)} placeholder="새 Credential 값" className="mt-3 min-h-11 w-full rounded-md border border-surface-700 bg-surface-950 px-3 text-[14px] text-surface-100 outline-none focus:border-primary-400" />
                      <button type="button" disabled={credentialSecureBusy || !credentialRotateCandidate} onClick={rotateCredential} className="mt-3 min-h-10 rounded-md bg-primary-600 px-4 text-[14px] font-medium text-white hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-50">{credentialSecureBusy ? '확인 중…' : '영향 확인 후 교체'}</button>
                    </section>
                  )}
                </div>
              )}

              {connectionDetailTab === 'agents' && (
                <div className="space-y-3">
                  <div><h5 className="text-base font-semibold text-surface-100">허용 Agent</h5><p className="mt-1 text-[14px] text-surface-400">이 Connection을 사용할 수 있는 Agent를 관리합니다. 변경 시 영향 preview와 Admin 승인을 거칩니다.</p></div>
                  <div className="divide-y divide-surface-800 border-y border-surface-800">
                    {[...selectedConnection.projects].sort((a, b) => {
                      const aOn = ['connected', 'inherited'].includes(a.status) ? 0 : 1;
                      const bOn = ['connected', 'inherited'].includes(b.status) ? 0 : 1;
                      return aOn - bOn || a.projectName.localeCompare(b.projectName);
                    }).map(project => {
                      const connected = ['connected', 'inherited'].includes(project.status);
                      const key = `${selectedConnection.id}:${project.projectId}`;
                      const saving = connectionSavingKey === key;
                      const rowError = connectionProjectErrors[key];
                      return <div key={key} className="flex min-h-14 items-start justify-between gap-3 py-2">
                        <div className="min-w-0 pt-1"><div className="truncate text-[14px] font-medium text-surface-200">{project.projectName}</div><div className="truncate text-[13px] text-surface-400">{connected ? '이 프로젝트에서 사용 중' : plainConnectionStatus(project.status)}</div>{rowError && <div role="alert" className="mt-1 text-[13px] leading-relaxed tone-danger tone-text">연결 실패: {rowError}</div>}</div>
                        <div className="flex shrink-0 flex-col gap-2 sm:flex-row"><button disabled={saving || !selectedConnection.enabled} onClick={() => updateConnectionProject(selectedConnection, project.projectId, connected ? 'deny' : 'allow')} className={`tone-action min-h-10 rounded-md px-3 text-[13px] transition-colors disabled:cursor-not-allowed ${connected ? 'tone-danger' : 'tone-success'}`}>{saving ? '저장 중…' : rowError && !connected ? '다시 시도' : connected ? '해제' : '연결'}</button></div>
                      </div>;
                    })}
                  </div>
                </div>
              )}

              {connectionDetailTab === 'advanced' && (
                <div className="space-y-4">
                  <div><h5 className="text-base font-semibold text-surface-100">진단 상태</h5><p className="mt-1 text-[14px] text-surface-400">저장·프로젝트 권한과 실제 Provider 인증은 서로 다른 상태입니다.</p></div>
                  <dl className="divide-y divide-surface-800 border-y border-surface-800">
                    <div className="py-3"><dt className="text-[13px] text-surface-400">Project access</dt><dd className="mt-1 text-[14px] text-surface-200">{selectedConnection.readiness.access.status}</dd></div>
                    <div className="py-3"><dt className="text-[13px] text-surface-400">Materialization</dt><dd className="mt-1 text-[14px] text-surface-200">{selectedConnection.readiness.materialization.status}</dd></div>
                    <div className="py-3"><dt className="text-[13px] text-surface-400">Provider health</dt><dd className="mt-1 text-[14px] text-surface-200">{selectedConnection.readiness.providerHealth.status}</dd></div>
                    <div className="py-3"><dt className="text-[13px] text-surface-400">Reason code</dt><dd className="mt-1 break-all font-mono text-[13px] text-surface-200">{selectedConnection.readiness.providerHealth.reasonCode || '확인 근거 없음'}</dd></div>
                  </dl>
                </div>
              )}
            </div>
          </aside>
        </div>
      )}

      {isPersonalCredentialMode && personalSection === 'projects' && (
        <section className="rounded-xl border border-surface-700 bg-surface-950/30 overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-800 space-y-3">
            <div>
              <h4 className="text-base font-semibold text-gray-200">내 Credential을 사용할 수 있는 AI 작업 공간</h4>
              <p className="text-[14px] text-gray-500 mt-1">프로젝트를 허용하면 그 프로젝트의 Primary AI 팀원과 Helper Agent가 <strong className="text-gray-300 font-medium">내 요청을 처리할 때만</strong> 이 Credential을 사용할 수 있습니다.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[13px]">
              <div className="rounded-lg border border-surface-800 bg-surface-950/50 px-3 py-2">
                <div className="text-gray-500">소유자</div>
                <div className="text-gray-200 mt-1">나만</div>
              </div>
              <div className="rounded-lg border border-surface-800 bg-surface-950/50 px-3 py-2">
                <div className="text-gray-500">사용 가능한 AI</div>
                <div className="text-gray-200 mt-1">허용한 프로젝트의 팀원·Helper</div>
              </div>
              <div className="rounded-lg border border-surface-800 bg-surface-950/50 px-3 py-2">
                <div className="text-gray-500">사용 조건</div>
                <div className="text-gray-200 mt-1">내가 시작한 실행에서만</div>
              </div>
            </div>
            <p className="text-[12px] text-gray-600">프로젝트의 다른 구성원, 다른 사용자의 세션, 외부에 배포된 AI Service에는 이 개인 Credential이 자동으로 전달되지 않습니다. 실제 값은 화면과 대화에 표시되지 않습니다.</p>
          </div>
          <div className="divide-y divide-surface-800">
            {credentials.length === 0 && <div className="px-4 py-8 text-center text-[14px] text-gray-500">먼저 ‘연결과 상태’에서 개인 API 키나 로그인 계정을 추가하세요.</div>}
            {credentials.map(credential => {
              const stats = credentialAccessStats(credential);
              return (
                <div key={credential.id} className="px-4 py-4 space-y-3">
                  <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-2">
                    <div>
                      <div className="text-base font-semibold text-gray-100">{credential.display_name || credential.id}</div>
                      <div className="text-[13px] text-gray-500 font-mono mt-1">{credential.default_env_name || credential.secret_name} · {friendlyScope(credential.scope)}</div>
                    </div>
                    <span className="tone-pill tone-success px-2 py-0.5 text-[12px] self-start">연결 {stats.allowed}/{stats.total}</span>
                  </div>
                  <div className="grid max-h-72 grid-cols-1 gap-2 overflow-y-auto pr-1 md:grid-cols-2 xl:grid-cols-3">
                    {projects.map(project => {
                      const allowed = isCredentialAllowedForProject(project.id, credential);
                      const label = accessLabelFor(project.id, credential);
                      return (
                        <button
                          key={`${credential.id}:${project.id}`}
                          type="button"
                          onClick={() => setCredentialProjectPolicy(project.id, credential, !allowed)}
                          className={`text-left rounded-lg border px-3 py-2 transition-colors ${allowed ? 'tone-success tone-bg-soft tone-border' : 'border-surface-800 bg-surface-950/40 hover:border-surface-600'}`}
                        >
                          <div className="text-[14px] font-medium text-gray-200 truncate">{project.name}</div>
                          <div className={`mt-1 text-[12px] ${allowed ? 'tone-text opacity-70' : 'text-gray-600'}`}>{label === 'Allowed' ? '내 AI 실행에서 사용 가능' : label}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {hasPendingAccessChanges && (
        <div className="tone-card tone-warning rounded-lg px-3 py-2 text-[14px] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <span>저장 전 변경 {pendingAccessPolicies.length}개가 있습니다. 저장해야 실제 Runtime Box 권한에 반영됩니다.</span>
          <span className="flex gap-2">
            <button disabled={accessSaving} onClick={cancelAccessChanges} className="px-3 py-1.5 text-[14px] rounded-lg border border-surface-700 text-gray-300 hover:bg-surface-800 disabled:opacity-40 transition-colors">취소</button>
            <button disabled={accessSaving} onClick={saveAccessChanges} className="px-3 py-1.5 text-[14px] rounded-lg bg-primary-600 text-white hover:bg-primary-500 disabled:opacity-40 transition-colors">{accessSaving ? '저장 중…' : '변경 저장'}</button>
          </span>
        </div>
      )}

      {!isPersonalCredentialMode && isAdmin && (
        <section className="rounded-xl border border-surface-800 bg-surface-950/30 px-4 py-3">
          <button
            type="button"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced(value => !value)}
            className="flex min-h-10 w-full items-center justify-between gap-3 text-left"
          >
            <span>
              <span className="block text-[14px] font-medium text-surface-300">고급 Credential 관리</span>
              <span className="mt-1 block text-[13px] text-surface-500">env·파일 주입·외부 동기화처럼 운영자에게만 필요한 기술 설정입니다.</span>
            </span>
            <span className="text-[13px] text-surface-500">{showAdvanced ? '접기' : '열기'}</span>
          </button>
        </section>
      )}

      {showAdvanced && !isPersonalCredentialMode && <section className="rounded-xl border border-surface-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-800 flex items-center justify-between gap-3">
          <div>
            <h4 className="text-base font-semibold text-gray-200">외부 동기화 대상</h4>
            <p className="text-[14px] text-gray-600 mt-1">선택한 Vault 키를 GitHub Actions 같은 외부 저장소에 복사하는 별도 대상입니다. 일반 API key 등록에는 필요 없습니다.</p>
          </div>
          {isAdmin && (
            <button onClick={() => setShowTargetForm(v => !v)} className="px-3 py-1.5 text-[14px] rounded-md border border-surface-700 text-gray-300 hover:bg-surface-800 transition-colors">
              {showTargetForm ? 'GitHub 동기화 닫기' : '+ GitHub Actions 동기화 추가'}
            </button>
          )}
        </div>
        <div className="divide-y divide-surface-800">
          {targets.length === 0 ? (
            <div className="px-4 py-8 text-base text-gray-500 text-center">아직 외부 동기화 대상이 없습니다. Vault 저장만 필요하다면 이 상태가 정상입니다.</div>
          ) : targets.map(t => {
            const hasProblem = t.last_status === 'error' || t.last_status === 'missing' || Boolean(t.last_error);
            return (
              <div key={t.id} className="px-4 py-4 grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-4 items-center">
                <div className="space-y-2 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold text-gray-100">{friendlyTargetType(t.target_type)}</span>
                    <span className={`tone-pill px-2 py-0.5 text-[13px] ${hasProblem ? 'tone-warning' : 'tone-success'}`}>{hasProblem ? '확인 필요' : '동기화됨'}</span>
                  </div>
                  <div className="text-base text-gray-300"><span className="text-gray-500">키:</span> {t.display_name || t.credential_id}</div>
                  <div className="text-[14px] text-gray-500">
                    저장소 <span className="font-mono text-gray-300">{t.target_ref?.repo || '-'}</span> · Secret 이름 <span className="font-mono text-gray-300">{t.target_ref?.secret_name || '-'}</span>
                  </div>
                  <div className="text-[13px] text-gray-600">
                    상태 {t.last_status || 'unknown'} · 마지막 확인 {formatDateTime(t.last_checked_at)} · 마지막 동기화 {formatDateTime(t.last_synced_at)}
                    {t.last_error ? <span className="text-red-300"> · 오류: {t.last_error}</span> : null}
                  </div>
                </div>
                <div className="flex gap-2 lg:justify-end">
                  <button onClick={() => refreshTargetStatus(t.id)} className="px-3 py-2 text-[14px] rounded-md border border-surface-700 text-gray-300 hover:bg-surface-800 transition-colors">상태 확인</button>
                  {isAdmin && <button onClick={() => syncTarget(t)} className="px-3 py-2 text-[14px] rounded-md bg-primary-600/20 border border-primary-500/30 text-primary-300 hover:bg-primary-600/30 transition-colors">GitHub에 다시 쓰기</button>}
                </div>
              </div>
            );
          })}
        </div>
      </section>}

      {connectionMode !== 'none' && (isAdmin || isPersonalCredentialMode) && (!isPersonalCredentialMode || personalSection === 'connections') && (
        <section ref={addConnectionRef} className="rounded-xl border border-primary-500/30 bg-primary-500/5 p-4 space-y-4 scroll-mt-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 className="text-base font-semibold text-gray-100">외부 연결 추가</h4>
              <p className="text-[14px] text-gray-500 mt-1">API key를 직접 저장하거나 OAuth 계정에 로그인해 연결할 수 있습니다.</p>
            </div>
            <button onClick={() => setConnectionMode('none')} className="text-gray-500 hover:text-gray-300">닫기</button>
          </div>

          {connectionMode === 'picker' && (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {[
                { mode: 'api_key_simple', title: 'API key', desc: 'OpenAI, Tiro, Naver처럼 env 하나로 쓰는 키를 바로 저장', badge: '추천' },
                { mode: 'api_key', title: '고급 typed credential', desc: 'kubeconfig, certificate 등 타입/파일 materialization이 필요한 단일 credential 저장', badge: '고급' },
                { mode: 'ssh', title: 'SSH private key', desc: '빠른 진입: SSH 접속 키를 Runtime Box 임시 파일로 제공', badge: '통합됨' },
                ...(!isPersonalCredentialMode ? [
                  { mode: 'oauth', title: 'OAuth 계정', desc: 'Google Workspace처럼 로그인해서 권한을 허용하고 필요할 때 재연결', badge: oauthProviders.some(provider => provider.configured) ? '사용 가능' : '설정 필요' },
                  { mode: 'cloud', title: 'Cloud 계정', desc: 'Azure tenant/client secret 또는 배포용 service principal', badge: '준비 중' },
                  { mode: 'cli', title: 'CLI profile', desc: 'gh, az, gws 같은 CLI 설정을 임시 프로필로 materialize', badge: '준비 중' },
                ] : []),
              ].map(item => (
                <button key={item.mode} onClick={() => setConnectionMode(item.mode as any)} className="text-left rounded-xl border border-surface-700 bg-surface-950/60 p-4 hover:border-primary-500/50 hover:bg-surface-900 transition-colors">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-base font-semibold text-gray-100">{item.title}</div>
                    <span className={`tone-pill text-[12px] px-2 py-0.5 ${['추천', '통합됨', '사용 가능'].includes(item.badge) ? 'tone-success' : item.badge === '설정 필요' ? 'tone-warning' : 'tone-muted'}`}>{item.badge}</span>
                  </div>
                  <p className="text-[14px] text-gray-500 mt-2 leading-relaxed">{item.desc}</p>
                </button>
              ))}
            </div>
          )}

          {connectionMode === 'oauth' && (
            <div className="rounded-lg border border-surface-700 bg-surface-950/50 p-4 space-y-4">
              <button onClick={() => setConnectionMode('picker')} className="text-[14px] text-gray-500 hover:text-gray-300">← 연결 방식 다시 선택</button>
              <div>
                <h5 className="text-lg font-semibold text-gray-100">조직 공용 Google Workspace 연결</h5>
                <p className="text-[14px] text-gray-500 mt-1">관리자가 조직 계정으로 로그인해 workspace Credential을 만듭니다. 생성 직후에는 어떤 Agent에도 자동 허용하지 않으며, 기존 Connection을 재인증하면 현재 Agent 권한을 그대로 유지합니다.</p>
              </div>
              <div className="rounded-xl border border-surface-700 bg-surface-900 p-4">
                <p className="text-[14px] leading-relaxed text-surface-300">Connection ID와 OAuth 설정은 Tower가 자동으로 준비합니다. Google 계정으로 로그인한 뒤 사용할 Agent만 선택하면 됩니다.</p>
                <button type="button" disabled={saving} onClick={() => void connectOrganizationGoogle()} className="tone-accent tone-action mt-3 min-h-10 rounded-md px-4 text-[14px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:bg-surface-800 disabled:text-surface-500">Google 계정으로 연결</button>
              </div>
            </div>
          )}

          {connectionMode !== 'picker' && connectionMode !== 'api_key_simple' && connectionMode !== 'api_key' && connectionMode !== 'ssh' && connectionMode !== 'oauth' && (
            <div className="rounded-lg border border-surface-700 bg-surface-950/50 p-4">
              <button onClick={() => setConnectionMode('picker')} className="text-[14px] text-gray-500 hover:text-gray-300 mb-3">← 연결 방식 다시 선택</button>
              <h5 className="text-base font-semibold text-gray-200">{connectionMode === 'cloud' ? 'Cloud 계정 연결' : 'CLI profile 연결'}</h5>
              <p className="text-[14px] text-gray-500 mt-2">이 타입은 아직 저장 동작 전 단계입니다.</p>
            </div>
          )}

          {connectionMode === 'api_key_simple' && (
            <div className="rounded-lg border border-surface-700 bg-surface-950/50 p-4 space-y-4">
              <button onClick={() => setConnectionMode('picker')} className="text-[14px] text-gray-500 hover:text-gray-300">← 다른 연결 방식 선택</button>
              <div>
                <h4 className="text-lg font-semibold text-gray-100">{isPersonalCredentialMode ? '내 개인 API key 추가' : 'API key 추가'}</h4>
                <p className="text-[14px] text-gray-500 mt-1">{isPersonalCredentialMode ? '내 개인 금고에 저장합니다. 다른 사용자는 값에 접근할 수 없고, 선택한 프로젝트에서 내 실행에만 주입됩니다.' : '외부 서비스에서 발급받은 키를 Tower Vault에 저장합니다. 값은 저장 후 다시 표시하지 않고, 프로젝트 실행 환경에는 “실행 이름”으로만 주입됩니다.'}</p>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                {Object.entries(API_KEY_PROVIDER_PRESETS).map(([provider, preset]) => (
                  <button
                    key={provider}
                    type="button"
                    onClick={() => setApiKeyForm(apiKeyFormFromProvider(provider))}
                    className={`text-left rounded-lg border p-3 transition-colors ${apiKeyForm.provider === provider ? 'border-primary-500/60 bg-primary-500/10' : 'border-surface-800 bg-surface-950/50 hover:border-surface-600'}`}
                  >
                    <div className="text-base font-semibold text-gray-100">{preset.label}</div>
                    <div className="text-[12px] text-gray-500 mt-1">{preset.defaultEnvName}</div>
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label>
                  <span className={labelClass}>서비스 이름</span>
                  <input className={inputClass} value={apiKeyForm.provider} onChange={e => setApiKeyForm(f => apiKeyFormFromServiceName(e.target.value, f.secretValue))} placeholder="예: notion" />
                  <span className="mt-1 block text-[12px] text-gray-600">서비스 이름만 넣으면 나머지 이름은 자동으로 만듭니다.</span>
                </label>
                <label>
                  <span className={labelClass}>바로 사용할 프로젝트</span>
                  <select className={inputClass} value={apiKeyProjectId} onChange={e => setApiKeyProjectId(e.target.value)}>
                    <option value="">저장만 하기</option>
                    {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                </label>
                <label className="md:col-span-2">
                  <span className={labelClass}>API key 값</span>
                  <input type="password" className={`${inputClass} font-mono`} autoComplete="new-password" data-1p-ignore value={apiKeyForm.secretValue} onChange={e => setApiKeyForm(f => ({ ...f, secretValue: e.target.value }))} placeholder="여기에 발급받은 API key를 붙여넣으세요. 저장 후 다시 표시되지 않습니다." />
                </label>
              </div>
              <details className="rounded-lg border border-surface-800 bg-surface-950/40 p-3 text-[12px] text-gray-500">
                <summary className="cursor-pointer text-gray-400">고급 이름 확인</summary>
                <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2">
                  <div>화면 이름 <span className="font-mono text-gray-300">{apiKeyForm.displayName}</span></div>
                  <div>실행 이름 <span className="font-mono text-gray-300">{apiKeyForm.defaultEnvName}</span></div>
                  <div>내부 ID <span className="font-mono text-gray-300">{apiKeyForm.id}</span></div>
                </div>
              </details>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border border-surface-800 bg-surface-950/60 p-3">
                <div className="text-[14px] text-gray-500">저장하면 <span className="font-mono text-gray-300">{apiKeyForm.defaultEnvName || '-'}</span> 이름으로 Runtime Box에 연결할 수 있습니다.{isPersonalCredentialMode ? ' 개인 금고 값은 다른 사용자에게 보이지 않습니다.' : ''}</div>
                <button disabled={saving || !apiKeyForm.provider.trim() || !apiKeyForm.secretValue?.trim()} onClick={saveApiKey} className="px-4 py-2 rounded-md bg-primary-600 text-white text-base disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary-500 transition-colors">
                  {saving ? '저장 중…' : '저장'}
                </button>
              </div>
            </div>
          )}

          {(connectionMode === 'api_key' || connectionMode === 'ssh') && (
            <>
              <button onClick={() => setConnectionMode('picker')} className="text-[14px] text-gray-500 hover:text-gray-300">← 연결 방식 다시 선택</button>
              <div>
                <h4 className="text-base font-semibold text-gray-100">새 Typed credential 저장</h4>
                <p className="text-[14px] text-gray-500 mt-1">타입별로 env 또는 임시 파일 materialization 방식을 정해 저장합니다. 파일형 secret은 Runtime Box에서 원문 env가 아니라 path env로만 제공됩니다.</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label><span className={labelClass}>Credential 타입</span><select className={inputClass} value={typedForm.typeId} onChange={e => {
                  const next = credentialTypes.find(t => t.id === e.target.value);
                  if (next) applyCredentialTypeDefaults(next);
                }}>
                  {credentialTypes.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select></label>
                <label><span className={labelClass}>표시 이름</span><input className={inputClass} value={typedForm.displayName} onChange={e => setTypedForm(f => ({ ...f, displayName: e.target.value }))} /></label>
                <label><span className={labelClass}>Credential ID</span><input className={inputClass} value={typedForm.id} onChange={e => setTypedForm(f => ({ ...f, id: e.target.value }))} /></label>
                <label><span className={labelClass}>Secret store name</span><input className={inputClass} value={typedForm.secretName} onChange={e => setTypedForm(f => ({ ...f, secretName: e.target.value }))} /></label>
                <label><span className={labelClass}>{selectedCredentialType?.materialization === 'file' ? 'Raw env name hidden' : 'Runtime env name'}</span><input className={inputClass} value={typedForm.defaultEnvName} onChange={e => setTypedForm(f => ({ ...f, defaultEnvName: e.target.value }))} /></label>
                <label><span className={labelClass}>Project optional</span><select className={inputClass} value={typedForm.projectId} onChange={e => setTypedForm(f => ({ ...f, projectId: e.target.value }))}>
                  <option value="">저장만 하고 프로젝트에는 아직 허용하지 않음</option>
                  {projects.map(project => <option key={project.id} value={project.id}>{project.name} · {project.id}</option>)}
                </select></label>
                {selectedCredentialType?.materialization === 'file' && (
                  <>
                    <label><span className={labelClass}>Path env name</span><input className={inputClass} value={typedForm.pathEnvName} onChange={e => setTypedForm(f => ({ ...f, pathEnvName: e.target.value }))} placeholder={selectedCredentialType.defaultPathEnvName || 'CREDENTIAL_FILE'} /></label>
                    <label><span className={labelClass}>Filename</span><input className={inputClass} value={typedForm.filename} onChange={e => setTypedForm(f => ({ ...f, filename: e.target.value }))} placeholder={selectedCredentialType.defaultFilename || 'credential'} /></label>
                    <label><span className={labelClass}>File mode</span><input className={inputClass} value={typedForm.mode} onChange={e => setTypedForm(f => ({ ...f, mode: e.target.value }))} placeholder="0600" /></label>
                  </>
                )}
              </div>
              {selectedCredentialType && <p className="text-[14px] text-gray-500 leading-relaxed">{selectedCredentialType.description}</p>}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 rounded-lg border border-surface-800 bg-surface-950/40 p-3">
                {selectedCredentialType?.fields.map(field => (
                  <label key={field.id} className="block">
                    <span className={labelClass}>{field.label}{field.required ? ' *' : ''}</span>
                    {field.multiline ? (
                      <textarea
                        className={`${inputClass} min-h-40 font-mono text-[14px]`}
                        autoComplete="new-password"
                        value={typedForm.values[field.id] || ''}
                        onChange={e => setTypedForm(f => ({ ...f, values: { ...f.values, [field.id]: e.target.value } }))}
                        placeholder={field.placeholder || field.label}
                      />
                    ) : (
                      <input
                        type={field.secret ? 'password' : 'text'}
                        className={inputClass}
                        autoComplete="new-password"
                        value={typedForm.values[field.id] || ''}
                        onChange={e => setTypedForm(f => ({ ...f, values: { ...f.values, [field.id]: e.target.value } }))}
                        placeholder={field.placeholder || field.label}
                      />
                    )}
                  </label>
                ))}
              </div>
              {selectedCredentialType?.materialization === 'file' ? (
                <div className="tone-card tone-success rounded-lg p-3 text-[14px] leading-relaxed">
                  저장 후 Runtime Box에서는 <span className="font-mono">{typedForm.pathEnvName || selectedCredentialType.defaultPathEnvName || 'CREDENTIAL_FILE'}</span> 환경변수에 임시 파일 경로가 들어갑니다. <span className="font-mono">env</span>/<span className="font-mono">printenv</span> 같은 명령에는 이 파일도 제공되지 않습니다.
                </div>
              ) : null}
              <button disabled={saving || !selectedCredentialType} onClick={saveTypedCredential} className="px-4 py-2 rounded-md bg-primary-600 text-white text-base disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary-500 transition-colors">
                {saving ? '저장 중…' : 'Typed credential 저장'}
              </button>

              <div className="pt-3 border-t border-surface-800">
                <h4 className="text-base font-semibold text-gray-100">{isPersonalCredentialMode ? '내 로그인 정보 세트 추가' : 'Credential bundle 저장'}</h4>
                <p className="text-[14px] text-gray-500 mt-1">{isPersonalCredentialMode ? '웹사이트 로그인처럼 ID/비밀번호가 함께 필요한 값을 내 개인 금고에 저장하고, 선택한 프로젝트에서 내 실행에만 주입합니다.' : '여러 env/secret을 하나의 Runtime Box profile로 묶어야 하면 bundle을 사용합니다.'}</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                  <label><span className={labelClass}>Credential 종류</span><select className={inputClass} value={bundleForm.typeId} onChange={e => {
                    const next = bundleTypes.find(t => t.id === e.target.value);
                    setBundleForm({
                      typeId: e.target.value,
                      instanceId: next?.defaultInstanceId || '',
                      displayName: next?.defaultDisplayName || '',
                      projectId: '',
                      values: {},
                      envNames: {},
                    });
                  }}>
                    {bundleTypes.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select></label>
                  <label><span className={labelClass}>표시 이름</span><input className={inputClass} value={bundleForm.displayName} onChange={e => setBundleForm(f => ({ ...f, displayName: e.target.value }))} /></label>
                  <label><span className={labelClass}>Instance ID</span><input className={inputClass} value={bundleForm.instanceId} onChange={e => setBundleForm(f => ({ ...f, instanceId: e.target.value }))} /></label>
                  <label><span className={labelClass}>Project optional</span><select className={inputClass} value={bundleForm.projectId} onChange={e => setBundleForm(f => ({ ...f, projectId: e.target.value }))}>
                    <option value="">저장만 하고 프로젝트에는 아직 허용하지 않음</option>
                    {projects.map(project => <option key={project.id} value={project.id}>{project.name} · {project.id}</option>)}
                  </select></label>
                </div>
                {selectedBundleType && <p className="text-[14px] text-gray-500 leading-relaxed mt-3">{selectedBundleType.description}</p>}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 rounded-lg border border-surface-800 bg-surface-950/40 p-3 mt-3">
                  {selectedBundleType?.fields.map(field => (
                    <label key={field.id} className={!field.secret ? '' : undefined}>
                      <span className={labelClass}>{field.label}{field.required ? ' *' : ''} · {bundleForm.envNames[field.id] || field.envName}</span>
                      {field.envNameEditable && (
                        <input
                          className={`${inputClass} mb-2 font-mono`}
                          value={bundleForm.envNames[field.id] || field.envName}
                          onChange={e => setBundleForm(f => ({ ...f, envNames: { ...f.envNames, [field.id]: e.target.value } }))}
                          placeholder={field.envName}
                        />
                      )}
                      <input
                        type={field.secret ? 'password' : 'text'}
                        className={inputClass}
                        autoComplete="new-password"
                        value={bundleForm.values[field.id] || ''}
                        onChange={e => setBundleForm(f => ({ ...f, values: { ...f.values, [field.id]: e.target.value } }))}
                        placeholder={field.placeholder || field.envName}
                      />
                    </label>
                  ))}
                </div>
                <button disabled={saving || !selectedBundleType} onClick={saveCredentialBundle} className="mt-3 px-4 py-2 rounded-md bg-primary-600 text-white text-base disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary-500 transition-colors">
                  {saving ? '저장 중…' : 'Credential bundle 저장'}
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {showAdvanced && showTargetForm && isAdmin && (
        <section className="rounded-xl border border-surface-700 p-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 className="text-base font-semibold text-gray-200">GitHub Actions Secret 동기화 추가</h4>
              <p className="text-[14px] text-gray-500 mt-1">필요할 때만 사용하세요. 선택한 Vault 키 값으로 GitHub 저장소의 Secret을 덮어쓸 수 있습니다.</p>
            </div>
            <button onClick={() => setShowTargetForm(false)} className="text-gray-500 hover:text-gray-300">닫기</button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label><span className={labelClass}>연결 키</span><select className={inputClass} value={targetForm.credentialId} onChange={e => setTargetForm(f => ({ ...f, credentialId: e.target.value }))}>
              <option value="">선택하세요</option>
              {credentials.map(c => <option key={c.id} value={c.id}>{c.display_name || c.id}</option>)}
            </select></label>
            <label><span className={labelClass}>GitHub secret 이름</span><input className={inputClass} value={targetForm.secretName} onChange={e => setTargetForm(f => ({ ...f, secretName: e.target.value }))} /></label>
            <label><span className={labelClass}>GitHub 저장소</span><input className={inputClass} value={targetForm.repo} onChange={e => setTargetForm(f => ({ ...f, repo: e.target.value }))} /></label>
            <label><span className={labelClass}>프로젝트</span><select className={inputClass} value={targetForm.projectId} onChange={e => setTargetForm(f => ({ ...f, projectId: e.target.value }))}>
              <option value="">프로젝트 없음</option>
              {projects.map(project => <option key={project.id} value={project.id}>{project.name} · {project.id}</option>)}
            </select></label>
          </div>
          <button disabled={saving || !targetForm.credentialId || !targetForm.repo || !targetForm.secretName} onClick={addGitHubTarget} className="px-4 py-2 rounded-md bg-primary-600 text-white text-base disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary-500 transition-colors">
            GitHub Actions 동기화 대상 추가
          </button>
        </section>
      )}
    </div>
  );
}

// ───── System Tab ─────

function SystemInfo() {
  const { t } = useTranslation('admin');
  const serverConfig = useSettingsStore((s) => s.serverConfig);
  const updateAvailable = useSettingsStore((s) => s.updateAvailable);
  const latestBuildId = useSettingsStore((s) => s.latestBuildId);
  const [apiHealth, setApiHealth] = useState<any | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(() => {
    fetch('/api/health')
      .then(r => r.json())
      .then(setApiHealth)
      .catch((err) => setApiHealth({ status: 'error', error: String(err) }));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const defaults = serverConfig?.defaults || {};
  const publicUrl = serverConfig?.publicUrl || apiHealth?.publicUrl || window.location.origin;
  const gitSha = serverConfig?.gitSha || apiHealth?.gitSha;
  const version = serverConfig?.version || apiHealth?.version || '-';
  const buildTime = serverConfig?.buildTime || apiHealth?.buildTime || '-';
  const buildId = serverConfig?.buildId || apiHealth?.buildId || '-';
  const apiOk = apiHealth?.status === 'ok';
  const configRows = [
    { label: t('version'), value: `v${version}${gitSha ? ` · ${String(gitSha).slice(0, 7)}` : ''}`, mono: true },
    { label: t('buildTime'), value: buildTime, mono: true },
    { label: t('buildId'), value: buildId, mono: true },
    { label: t('publicUrl'), value: publicUrl, mono: true },
    { label: t('serverRole'), value: serverConfig?.towerRole || '-', mono: true },
    { label: t('nodeEnv'), value: serverConfig?.nodeEnv || '-', mono: true },
    { label: t('workspace'), value: serverConfig?.workspaceRoot || '-', mono: true },
    { label: t('permissionMode'), value: serverConfig?.permissionMode || '-', mono: true },
    { label: t('claudeExecutable'), value: serverConfig?.claudeExecutable || '-', mono: true },
  ];
  const modelRows = [
    { label: t('sessionModel'), value: defaults.session || '-' },
    { label: t('aiReplyModel'), value: defaults.ai_reply || '-' },
    { label: t('taskExecutionModel'), value: defaults.ai_task || '-' },
  ];

  const copyDiagnostics = async () => {
    const payload = {
      apiHealth,
      browserTool: {
        deprecated: true,
        replacement: 'Runtime Box Playwright/system Chromium',
      },
      serverConfig: {
        version,
        gitSha,
        buildTime,
        buildId,
        publicUrl,
        towerRole: serverConfig?.towerRole,
        nodeEnv: serverConfig?.nodeEnv,
        workspaceRoot: serverConfig?.workspaceRoot,
        permissionMode: serverConfig?.permissionMode,
        claudeExecutable: serverConfig?.claudeExecutable,
        defaults,
        updateAvailable,
        latestBuildId,
      },
      capturedAt: new Date().toISOString(),
    };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold text-gray-300 uppercase tracking-wider">{t('systemDiagnostics')}</h3>
          <p className="text-[13px] text-gray-600 mt-1">{t('systemDiagnosticsIntro')}</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button onClick={refresh} className="px-3 py-1.5 text-[13px] rounded-md border border-surface-700 text-gray-400 hover:text-gray-200 hover:bg-surface-800 transition-colors">
            {t('refresh')}
          </button>
          <button onClick={copyDiagnostics} className="px-3 py-1.5 text-[13px] rounded-md bg-primary-600/20 border border-primary-500/30 text-primary-300 hover:bg-primary-600/30 transition-colors">
            {copied ? t('copied') : t('copyDiagnostics')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <HealthCard label={t('apiStatus')} ok={apiOk} detail={apiOk ? t('healthy') : (apiHealth?.error || t('notConnected'))} />
        <HealthCard label={t('updateStatus')} ok={!updateAvailable} detail={updateAvailable ? t('updateAvailableDetail', { buildId: latestBuildId || '-' }) : t('upToDate')} />
      </div>

      <div className="rounded-lg border border-surface-700 divide-y divide-surface-800/50">
        {configRows.map((row) => <InfoRow key={row.label} label={row.label} value={row.value} mono={row.mono} />)}
      </div>

      <div>
        <h3 className="text-[14px] font-semibold text-gray-500 uppercase tracking-wider mb-3">{t('defaultModels')}</h3>
        <div className="rounded-lg border border-surface-700 divide-y divide-surface-800/50">
          {modelRows.map((row) => <InfoRow key={row.label} label={row.label} value={row.value} mono />)}
        </div>
      </div>
    </div>
  );
}

// ───── AI Settings Management ─────

function AiUsageManagement({ token }: { token?: string | null }) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-[15px] font-semibold text-gray-300 uppercase tracking-wider">사용량</h3>
        <p className="text-[13px] text-gray-600 mt-1">이 VM의 AI 토큰 입출력, 추정 비용, 예산 잔량입니다. 전체 고객 예산 관리는 LiteLLM 관리 페이지에서 확인합니다.</p>
      </div>
      <AiTokenUsageDashboard token={token} />
    </div>
  );
}

interface AiComposerAdminSettings {
  enabled: boolean;
  emptyDraftEnabled: boolean;
  inlineDraftEnabled: boolean;
  debounceMs: number;
  minRequestIntervalMs: number;
  responseMaxAgeMs: number;
  minDraftLength: number;
  assistantContextChars: number;
  modelTimeoutMs: number;
}

function AiComposerSettingsPanel({ token }: { token?: string | null }) {
  const [settings, setSettings] = useState<AiComposerAdminSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const authHeaders = useCallback(() => ({
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }), [token]);

  useEffect(() => {
    fetch(`${API_BASE}/admin/ai-composer-settings`, { headers: authHeaders() })
      .then(response => response.ok ? response.json() : null)
      .then(data => { if (data) setSettings(data); })
      .catch(() => {});
  }, [authHeaders]);

  if (!settings) return <div className="text-sm text-surface-500">자동완성 설정을 불러오는 중…</div>;
  const update = <K extends keyof AiComposerAdminSettings>(key: K, value: AiComposerAdminSettings[K]) => setSettings({ ...settings, [key]: value });
  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE}/admin/ai-composer-settings`, {
        method: 'PATCH', headers: authHeaders(), body: JSON.stringify(settings),
      });
      if (response.ok) {
        setSettings(await response.json());
        window.dispatchEvent(new Event('tower:ai-composer-settings-changed'));
      }
    } finally { setSaving(false); }
  };
  const numberField = (label: string, key: keyof AiComposerAdminSettings, suffix: string) => (
    <label className="space-y-1 text-sm text-surface-300">
      <span>{label}</span>
      <div className="flex items-center gap-2">
        <input type="number" value={Number(settings[key])} onChange={event => update(key, Number(event.target.value) as never)} className="w-28 rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-surface-100" />
        <span className="text-xs text-surface-500">{suffix}</span>
      </div>
    </label>
  );
  return <div className="rounded-xl border border-surface-700 bg-surface-900/40 p-4 space-y-4">
    <div className="flex flex-wrap items-center gap-5">
      <label className="flex items-center gap-2 text-sm text-surface-200"><input type="checkbox" checked={settings.enabled} onChange={event => update('enabled', event.target.checked)} /> 입력창 AI 자동완성</label>
      <label className="flex items-center gap-2 text-sm text-surface-200"><input type="checkbox" checked={settings.emptyDraftEnabled} onChange={event => update('emptyDraftEnabled', event.target.checked)} /> 빈 입력창 추천</label>
      <label className="flex items-center gap-2 text-sm text-surface-200"><input type="checkbox" checked={settings.inlineDraftEnabled} onChange={event => update('inlineDraftEnabled', event.target.checked)} /> 작성 중 문장 자동완성</label>
    </div>
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {numberField('입력 정지 시간', 'debounceMs', 'ms')}
      {numberField('요청 최소 간격', 'minRequestIntervalMs', 'ms')}
      {numberField('직전 답변 문맥', 'assistantContextChars', '자')}
      {numberField('최소 입력 길이', 'minDraftLength', '자')}
      {numberField('UI 응답 유효기간', 'responseMaxAgeMs', 'ms')}
      {numberField('모델 timeout', 'modelTimeoutMs', 'ms')}
    </div>
    <div className="flex items-center justify-between border-t border-surface-800 pt-3">
      <p className="text-xs text-surface-500">저장 즉시 현재 탭에 반영되고, 다른 탭은 최대 30초 안에 갱신됩니다.</p>
      <button onClick={save} disabled={saving} className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? '저장 중…' : '설정 저장'}</button>
    </div>
  </div>;
}

function AiSettingsManagement({ token }: { token?: string | null }) {
  const { t } = useTranslation('admin');
  return (
    <div className="space-y-8">
      <section>
        <div className="mb-3">
          <h3 className="text-[15px] font-semibold text-gray-300 uppercase tracking-wider">입력창 자동완성</h3>
          <p className="text-[13px] text-gray-600 mt-1">재시작 없이 이 VM 전체의 mini 자동완성 동작을 조정합니다.</p>
        </div>
        <AiComposerSettingsPanel token={token} />
      </section>
      <section className="pt-6 border-t border-surface-800">
        <div className="mb-3">
          <h3 className="text-[15px] font-semibold text-gray-300 uppercase tracking-wider">{t('models')}</h3>
          <p className="text-[13px] text-gray-600 mt-1">{t('modelsIntro')}</p>
        </div>
        <ModelManagement token={token} />
      </section>
      <section className="pt-6 border-t border-surface-800">
        <div className="mb-3">
          <h3 className="text-[15px] font-semibold text-gray-300 uppercase tracking-wider">{t('accounts')}</h3>
          <p className="text-[13px] text-gray-600 mt-1">{t('accountsIntro')}</p>
        </div>
        <ClaudeAccountManagement token={token} />
      </section>
    </div>
  );
}

interface ClaudeModelEntry { id: string; name: string; badge: string; enabled: boolean; contextWindow?: number }
interface PiModelEntry {
  provider: string;
  modelId: string;
  name: string;
  badge: string;
  enabled: boolean;
  api?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  roles?: string[];
  _note?: string;
}
interface ModelDefaults { session: string; ai_reply: string; ai_task: string }
interface ModelsData { claude: ClaudeModelEntry[]; pi: PiModelEntry[]; defaults?: ModelDefaults }

function ModelManagement({ token }: { token?: string | null }) {
  const { t } = useTranslation('admin');
  const [models, setModels] = useState<ModelsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [addingPi, setAddingPi] = useState(false);
  const [newPi, setNewPi] = useState({ provider: 'litellm-responses', modelId: '', name: '', badge: '' });

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const fetchModels = useCallback(() => {
    fetch(`${API_BASE}/admin/models`, { headers })
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setModels(d))
      .catch(() => {});
  }, [token]);

  useEffect(() => { fetchModels(); }, [fetchModels]);

  const save = async (updated: ModelsData) => {
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/admin/models`, { method: 'PUT', headers, body: JSON.stringify(updated) });
      if (res.ok) {
        setModels(updated);
      }
    } finally {
      setSaving(false);
    }
  };

  const toggleClaude = (idx: number) => {
    if (!models) return;
    const updated = { ...models, claude: models.claude.map((m, i) => i === idx ? { ...m, enabled: !m.enabled } : m) };
    save(updated);
  };

  const togglePi = (idx: number) => {
    if (!models) return;
    const updated = { ...models, pi: models.pi.map((m, i) => i === idx ? { ...m, enabled: !m.enabled } : m) };
    save(updated);
  };

  const deletePi = (idx: number) => {
    if (!models) return;
    const updated = { ...models, pi: models.pi.filter((_, i) => i !== idx) };
    save(updated);
  };

  const inferPiModelDefaults = (entry: PiModelEntry): PiModelEntry => {
    const api = entry.api
      || (entry.provider === 'litellm-responses' ? 'openai-responses'
        : entry.provider === 'litellm' || entry.provider === 'openrouter' ? 'openai-completions'
        : undefined);
    return {
      ...entry,
      ...(api ? { api } : {}),
      contextWindow: entry.contextWindow ?? 272000,
      maxTokens: entry.maxTokens ?? (entry.provider === 'litellm-responses' ? 32000 : 128000),
      roles: entry.roles ?? ['full', 'managed', 'standalone'],
    };
  };

  const addPi = () => {
    if (!models || !newPi.modelId || !newPi.name) return;
    const entry: PiModelEntry = inferPiModelDefaults({ ...newPi, enabled: true });
    const updated = { ...models, pi: [...models.pi, entry] };
    save(updated);
    setNewPi({ provider: 'litellm-responses', modelId: '', name: '', badge: '' });
    setAddingPi(false);
  };

  if (!models) return <div className="text-gray-500 text-base py-8 text-center">{t('common:loading')}</div>;

  const rowClass = 'flex items-center gap-3 px-4 py-2.5 border-b border-surface-800 last:border-0';
  const toggleClass = (on: boolean) =>
    `w-9 h-5 rounded-full relative cursor-pointer transition-colors ${on ? 'bg-primary-500' : 'bg-surface-600'}`;
  const dotClass = (on: boolean) =>
    `absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${on ? 'left-4' : 'left-0.5'}`;

  const enabledClaude = models.claude.filter(m => m.enabled);
  const enabledPi = models.pi.filter(m => m.enabled);
  const currentDefaults: ModelDefaults = models.defaults ?? { session: 'litellm-responses/smartest', ai_reply: 'litellm-responses/mini', ai_task: 'litellm-responses/mini' };

  const saveDefaults = (key: keyof ModelDefaults, value: string) => {
    const updated = { ...models, defaults: { ...currentDefaults, [key]: value } };
    save(updated);
  };

  // Defaults may point at legacy fallback models or AI Router models. Store backend-native IDs here
  // (router models as provider/modelId, no UI prefix); the browser model-store adds
  // UI prefixes after /api/config. This keeps backend utility agents compatible.
  const defaultModelOptions = (_key: keyof ModelDefaults) => {
    const claudeOpts = enabledClaude.map(m => ({ id: m.id, name: m.name, group: 'Legacy fallback' }));
    const piOpts = enabledPi.map(m => ({ id: `${m.provider}/${m.modelId}`, name: m.name, group: 'AI Router' }));
    return [...claudeOpts, ...piOpts];
  };

  return (
    <div className="space-y-6">
      {/* Default Models */}
      <div>
        <h3 className="text-[15px] font-semibold text-gray-300 uppercase tracking-wider mb-2">{t('defaultModels')}</h3>
        <div className="bg-surface-800/50 rounded-lg border border-surface-700 divide-y divide-surface-700/50">
          {([
            { key: 'session' as const, label: t('sessionModel'), desc: t('sessionModelDesc') },
            { key: 'ai_reply' as const, label: t('aiReplyModel'), desc: t('aiReplyModelDesc') },
            { key: 'ai_task' as const, label: t('taskExecutionModel'), desc: t('taskExecutionModelDesc') },
          ]).map(({ key, label, desc }) => {
            const options = defaultModelOptions(key);
            const groups = [...new Set(options.map(o => o.group))];
            return (
              <div key={key} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="text-[15px] text-gray-200 font-medium">{label}</div>
                  <div className="text-[13px] text-gray-500">{desc}</div>
                </div>
                <select
                  value={currentDefaults[key]}
                  onChange={(e) => saveDefaults(key, e.target.value)}
                  className="bg-surface-700 border border-surface-600 rounded-md px-3 py-1.5 text-[15px] text-gray-200 min-w-[180px]"
                >
                  {groups.length > 1 ? (
                    groups.map(g => (
                      <optgroup key={g} label={g}>
                        {options.filter(o => o.group === g).map(o => (
                          <option key={o.id} value={o.id}>{o.name}</option>
                        ))}
                      </optgroup>
                    ))
                  ) : (
                    options.map(o => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))
                  )}
                </select>
              </div>
            );
          })}
        </div>
      </div>

      {/* Legacy fallback models */}
      <div>
        <h3 className="text-[15px] font-semibold text-gray-300 uppercase tracking-wider mb-2">{t('claudeMax')}</h3>
        <div className="bg-surface-800/50 rounded-lg border border-surface-700">
          {models.claude.map((m, i) => (
            <div key={m.id} className={rowClass}>
              <div className={toggleClass(m.enabled)} onClick={() => toggleClaude(i)}>
                <div className={dotClass(m.enabled)} />
              </div>
              <span className="text-[15px] text-gray-200 flex-1">{m.name}</span>
              <span className="text-[13px] text-gray-500 font-mono">{m.id}</span>
              <span className="text-[13px] px-1.5 py-0.5 rounded bg-surface-700 text-gray-400">{m.badge}</span>
            </div>
          ))}
        </div>
      </div>

      {/* AI Router models */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[15px] font-semibold text-gray-300 uppercase tracking-wider">{t('piOpenRouter')}</h3>
          <button
            onClick={() => setAddingPi(!addingPi)}
            className="text-[14px] text-primary-400 hover:text-primary-300 transition-colors"
          >
            {addingPi ? t('common:cancel') : t('addModel')}
          </button>
        </div>

        {addingPi && (
          <div className="bg-surface-800/50 rounded-lg border border-surface-700 p-4 mb-3 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <input
                placeholder={t('modelIdPlaceholder')}
                value={newPi.modelId}
                onChange={e => setNewPi({ ...newPi, modelId: e.target.value })}
                className="bg-surface-700 border border-surface-600 rounded px-3 py-1.5 text-[15px] text-gray-200 placeholder:text-gray-600"
              />
              <input
                placeholder={t('displayName')}
                value={newPi.name}
                onChange={e => setNewPi({ ...newPi, name: e.target.value })}
                className="bg-surface-700 border border-surface-600 rounded px-3 py-1.5 text-[15px] text-gray-200 placeholder:text-gray-600"
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <input
                placeholder={t('provider')}
                value={newPi.provider}
                onChange={e => setNewPi({ ...newPi, provider: e.target.value })}
                className="bg-surface-700 border border-surface-600 rounded px-3 py-1.5 text-[15px] text-gray-200 placeholder:text-gray-600"
              />
              <input
                placeholder={t('badgePlaceholder')}
                value={newPi.badge}
                onChange={e => setNewPi({ ...newPi, badge: e.target.value })}
                className="bg-surface-700 border border-surface-600 rounded px-3 py-1.5 text-[15px] text-gray-200 placeholder:text-gray-600"
              />
              <button
                onClick={addPi}
                disabled={!newPi.modelId || !newPi.name}
                className="bg-primary-600 hover:bg-primary-500 disabled:opacity-50 text-white text-[15px] rounded px-3 py-1.5 transition-colors"
              >
                {t('common:add')}
              </button>
            </div>
          </div>
        )}

        <div className="bg-surface-800/50 rounded-lg border border-surface-700">
          {models.pi.length === 0 && (
            <div className="text-gray-500 text-[15px] py-4 text-center">{t('noPiModels')}</div>
          )}
          {models.pi.map((m, i) => (
            <div key={`${m.provider}/${m.modelId}`} className={rowClass}>
              <div className={toggleClass(m.enabled)} onClick={() => togglePi(i)}>
                <div className={dotClass(m.enabled)} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[15px] text-gray-200">{m.name}</div>
                <div className="text-[12px] text-gray-600 font-mono truncate">
                  {[m.api, m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k ctx` : null, m.maxTokens ? `${Math.round(m.maxTokens / 1000)}k out` : null, m.roles?.length ? m.roles.join('/') : null].filter(Boolean).join(' · ')}
                </div>
              </div>
              <span className="text-[13px] text-gray-500 font-mono">{m.provider}/{m.modelId}</span>
              {m.badge && <span className="text-[13px] px-1.5 py-0.5 rounded bg-surface-700 text-gray-400">{m.badge}</span>}
              <button
                onClick={() => deletePi(i)}
                className="text-gray-600 hover:text-red-400 transition-colors p-1"
                title={t('common:delete')}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </div>

      {saving && <div className="text-[14px] text-primary-400 text-center">{t('common:saving')}</div>}
    </div>
  );
}

function HealthCard({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="rounded-lg border border-surface-700 bg-surface-800/30 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${ok ? 'tone-success tone-bg' : 'tone-warning tone-bg'}`} />
        <span className="text-[14px] font-semibold text-gray-300">{label}</span>
      </div>
      <p className="mt-1 text-[13px] text-gray-500 truncate" title={detail}>{detail}</p>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="text-[15px] text-gray-400 shrink-0">{label}</span>
      <span className={`text-[15px] text-gray-200 ${mono ? 'font-mono' : ''} min-w-0 max-w-[680px] truncate text-right`} title={value}>
        {value}
      </span>
    </div>
  );
}

// ───── AI Token Usage Dashboard ─────

interface AiTokenBudgetSnapshot {
  customer: string;
  ok: boolean;
  models?: string[];
  maxBudget?: number | null;
  budgetDuration?: string | null;
  spend?: number | null;
  remaining?: number | null;
  usedPct?: number | null;
  metadata?: Record<string, unknown> | null;
  updatedAt: string;
  error?: string;
}

interface AiTokenUsageDay {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
  turns: number;
}

interface AiTokenUsageSummary {
  days: number;
  daily: AiTokenUsageDay[];
  totals: Omit<AiTokenUsageDay, 'date'>;
}

function formatBudgetMoney(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '-';
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 0 : 2 })}`;
}

function formatTokenCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '-';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function UsageMetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-surface-700 bg-surface-800/50 px-4 py-3">
      <div className="text-[12px] text-gray-600 uppercase tracking-wider">{label}</div>
      <div className="mt-1 text-[20px] font-semibold text-gray-100 tabular-nums">{value}</div>
    </div>
  );
}

function TinyTokenUsageChart({ data }: { data: AiTokenUsageDay[] }) {
  const width = 720;
  const height = 180;
  const padX = 28;
  const padY = 18;
  const max = Math.max(1, ...data.map(d => d.totalTokens));
  const points = data.map((d, i) => {
    const x = padX + (data.length <= 1 ? 0 : (i / (data.length - 1)) * (width - padX * 2));
    const y = height - padY - (d.totalTokens / max) * (height - padY * 2);
    return { x, y, d };
  });
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const area = `${path} L ${width - padX} ${height - padY} L ${padX} ${height - padY} Z`;

  return (
    <div className="rounded-lg border border-surface-700 bg-surface-900/60 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[14px] font-medium text-gray-300">최근 {data.length}일 토큰 사용량</div>
        <div className="text-[12px] text-gray-600">input + output 기준</div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-[180px] overflow-visible">
        <line x1={padX} y1={height - padY} x2={width - padX} y2={height - padY} stroke="currentColor" className="text-surface-700" strokeWidth="1" />
        <path d={area} fill="currentColor" className="text-primary-500/10" />
        <path d={path} fill="none" stroke="currentColor" className="text-primary-400" strokeWidth="2.5" />
        {points.map((p, i) => (
          <g key={p.d.date}>
            {(i === 0 || i === points.length - 1 || p.d.totalTokens === max) && (
              <>
                <circle cx={p.x} cy={p.y} r="3" fill="currentColor" className="text-primary-300" />
                <text x={p.x} y={Math.max(12, p.y - 8)} textAnchor="middle" className="fill-gray-500 text-[12px]">
                  {formatTokenCount(p.d.totalTokens)}
                </text>
              </>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

function AiTokenUsageDashboard({ token }: { token?: string | null }) {
  const [rows, setRows] = useState<AiTokenBudgetSnapshot[]>([]);
  const [usage, setUsage] = useState<AiTokenUsageSummary | null>(null);
  const [capturedAt, setCapturedAt] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const headers = useCallback(() => ({
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }), [token]);

  const fetchBudgets = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/admin/ai-token-budgets`, { headers: headers() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'AI token budget 조회 실패');
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setUsage(data.usage || null);
      setCapturedAt(data.capturedAt || '');
    } catch (err: any) {
      setError(err?.message || 'AI token budget 조회 실패');
      setRows([]);
      setUsage(null);
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => { fetchBudgets(); }, [fetchBudgets]);

  if (loading) return <div className="text-gray-500 text-base py-6 text-center">Loading AI usage…</div>;

  const budget = rows[0];
  const totals = usage?.totals;
  const budgetPct = budget && typeof budget.usedPct === 'number' && Number.isFinite(budget.usedPct)
    ? Math.max(0, Math.min(100, budget.usedPct))
    : null;
  const remaining = budget?.maxBudget == null ? null : budget?.remaining;
  const budgetStatusColor = !budget?.ok ? 'tone-danger tone-bg' : budgetPct == null ? 'bg-gray-500' : budgetPct >= 90 ? 'tone-danger tone-bg' : budgetPct >= 70 ? 'tone-warning tone-bg' : 'tone-success tone-bg';
  const budgetPolicy = budget?.metadata?.['budget_policy'];
  const budgetPolicyText = typeof budgetPolicy === 'string' || typeof budgetPolicy === 'number' || typeof budgetPolicy === 'boolean'
    ? String(budgetPolicy)
    : '';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-[14px] text-gray-500">
        <div>current VM · {capturedAt ? `captured ${new Date(capturedAt).toLocaleString()}` : 'AI usage'}</div>
        <button
          onClick={fetchBudgets}
          className="px-2.5 py-1 text-[13px] text-gray-400 hover:text-gray-200 bg-surface-900 border border-surface-700 rounded-md"
        >새로고침</button>
      </div>

      {error && <div className="tone-card tone-warning px-4 py-3 text-[14px] rounded-lg">{error}</div>}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <UsageMetricCard label="입력 토큰" value={formatTokenCount(totals?.inputTokens)} />
        <UsageMetricCard label="출력 토큰" value={formatTokenCount(totals?.outputTokens)} />
        <UsageMetricCard label="캐시 읽기" value={formatTokenCount(totals?.cacheReadTokens)} />
        <UsageMetricCard label="추정 비용" value={formatBudgetMoney(totals?.costUsd)} />
      </div>

      {usage?.daily && usage.daily.length > 0 && <TinyTokenUsageChart data={usage.daily} />}

      <div className="bg-surface-800/50 rounded-lg border border-surface-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-700/60">
          <div className="text-[14px] font-medium text-gray-300">AI Token Budget</div>
          <div className="text-[12px] text-gray-600">이 VM의 LiteLLM key 예산 잔량</div>
        </div>
        {!budget ? (
          <div className="px-4 py-8 text-center text-[15px] text-gray-500">표시할 AI token budget이 없습니다.</div>
        ) : (
          <div className="px-4 py-3">
            <div className="flex items-center gap-3">
              <span className={`w-2 h-2 rounded-full ${budgetStatusColor}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] text-gray-200 font-medium">{budget.customer}</span>
                  {budgetPolicyText && (
                    <span className="text-[12px] px-1.5 py-0.5 rounded bg-primary-500/10 text-primary-300 border border-primary-500/20">
                      {budgetPolicyText}
                    </span>
                  )}
                </div>
                <div className="text-[12px] text-gray-600 font-mono truncate">
                  {(budget.models || []).join(', ') || 'models unknown'} · updated {new Date(budget.updatedAt).toLocaleString()}
                </div>
              </div>
              {budget.ok ? (
                <div className="text-right shrink-0">
                  <div className="text-[15px] text-gray-200 font-medium">
                    {formatBudgetMoney(budget.spend)} / {formatBudgetMoney(budget.maxBudget)}
                  </div>
                  <div className="text-[13px] text-gray-500">
                    remaining {formatBudgetMoney(remaining)} · {budget.budgetDuration || 'no duration'}
                  </div>
                </div>
              ) : (
                <div className="text-[14px] text-red-300 max-w-[300px] truncate" title={budget.error}>{budget.error || 'error'}</div>
              )}
            </div>
            {budget.ok && budgetPct != null && (
              <div className="mt-2 h-1.5 rounded-full bg-surface-900 overflow-hidden">
                <div className={`h-full ${budgetStatusColor}`} style={{ width: `${budgetPct}%` }} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ───── Legacy fallback accounts tab ─────

interface ClaudeAccount {
  id: string;
  label: string;
  configDir: string;
  tier: 'max' | 'pro' | 'api';
  isDefault: boolean;
  enabled: boolean;
  createdAt?: string;
}

interface ProjectSummary {
  id: string;
  name: string;
  claude_account_id: string | null;
}

interface CodexAuthStatus {
  configured: boolean;
  provider: string;
  type?: string;
  agentDir?: string;
  authPath?: string;
  accountId?: string | null;
  email?: string | null;
  planType?: string | null;
  expiresAt?: string | null;
  expired?: boolean | null;
  latestUsage?: {
    ts?: string;
    rateLimits?: {
      plan_type?: string | null;
      primary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
      secondary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
    };
    usage?: any;
  } | null;
}

function ClaudeAccountManagement({ token }: { token?: string | null }) {
  const { t } = useTranslation('admin');
  const confirm = useConfirm();
  const [accounts, setAccounts] = useState<ClaudeAccount[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [codexAuth, setCodexAuth] = useState<CodexAuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newAccount, setNewAccount] = useState({ id: '', label: '', configDir: '', tier: 'max' as string, isDefault: false });
  const [error, setError] = useState('');
  const [assigningProject, setAssigningProject] = useState<string | null>(null);

  const headers = useCallback(() => ({
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }), [token]);

  const fetchData = useCallback(async () => {
    try {
      const [accRes, projRes, codexRes] = await Promise.all([
        fetch(`${API_BASE}/admin/claude-accounts`, { headers: headers() }),
        fetch(`${API_BASE}/projects`, { headers: headers() }),
        fetch(`${API_BASE}/admin/openai-codex-auth/status`, { headers: headers() }),
      ]);
      if (accRes.ok) setAccounts(await accRes.json());
      if (projRes.ok) setProjects(await projRes.json());
      if (codexRes.ok) setCodexAuth(await codexRes.json());
    } catch {} finally { setLoading(false); }
  }, [headers]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleCreate = async () => {
    setError('');
    if (!newAccount.id || !newAccount.label || !newAccount.configDir) {
      setError(t('accountFieldsRequired')); return;
    }
    try {
      const res = await fetch(`${API_BASE}/admin/claude-accounts`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify(newAccount),
      });
      if (res.ok) {
        setShowForm(false);
        setNewAccount({ id: '', label: '', configDir: '', tier: 'max', isDefault: false });
        fetchData();
      } else {
        const data = await res.json();
        setError(data.error || t('creationFailed'));
      }
    } catch { setError(t('serverError')); }
  };

  const handleDelete = async (id: string) => {
    const ok = await confirm({
      title: t('deleteAccount', { defaultValue: 'Delete account' }),
      message: t('deleteAccountConfirm', { id }),
      confirmLabel: t('common:delete', { defaultValue: 'Delete' }),
      danger: true,
    });
    if (!ok) return;
    await fetch(`${API_BASE}/admin/claude-accounts/${id}`, { method: 'DELETE', headers: headers() });
    fetchData();
  };

  const handleToggle = async (acc: ClaudeAccount, field: 'enabled' | 'isDefault') => {
    await fetch(`${API_BASE}/admin/claude-accounts/${acc.id}`, {
      method: 'PUT', headers: headers(),
      body: JSON.stringify({ [field]: field === 'isDefault' ? true : !acc.enabled }),
    });
    fetchData();
  };

  const handleAssign = async (projectId: string, accountId: string | null) => {
    await fetch(`${API_BASE}/admin/projects/${projectId}/claude-account`, {
      method: 'PUT', headers: headers(),
      body: JSON.stringify({ accountId }),
    });
    setAssigningProject(null);
    fetchData();
  };

  const getAccountForProject = (p: ProjectSummary) =>
    accounts.find(a => a.id === p.claude_account_id);

  const defaultAccount = accounts.find(a => a.isDefault && a.enabled);

  if (loading) return <div className="text-gray-500 text-base p-4">{t('common:loading')}</div>;

  return (
    <div className="space-y-5">
      {/* ── ChatGPT Codex Account Section ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-[15px] font-medium text-gray-300">ChatGPT Codex 계정</h3>
            <p className="text-[13px] text-gray-600 mt-0.5">Direct GPT / Codex-LB 경로가 사용하는 ChatGPT/Codex OAuth 상태입니다. 기본 사용자 경로는 AI Router(Smartest/Mini)입니다.</p>
          </div>
          <button
            onClick={fetchData}
            className="px-2.5 py-1 text-[13px] text-gray-400 hover:text-gray-200 bg-surface-800 border border-surface-700 rounded-md"
          >새로고침</button>
        </div>
        <div className="bg-surface-800 border border-surface-700 rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${codexAuth?.configured && !codexAuth?.expired ? 'tone-success tone-bg' : 'tone-warning tone-bg'}`} />
            <span className="text-[15px] text-gray-200 font-medium">
              {codexAuth?.configured ? 'openai-codex 로그인됨' : 'openai-codex 로그인 필요'}
            </span>
            {codexAuth?.planType && (
              <span className={`tone-pill text-[12px] font-semibold px-1.5 py-0.5 rounded ${codexAuth.planType === 'free' ? 'tone-warning' : 'tone-success'}`}>
                {codexAuth.planType.toUpperCase()}
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1 text-[13px] text-gray-500">
            <div>email: <span className="text-gray-300">{codexAuth?.email || '-'}</span></div>
            <div>expires: <span className="text-gray-300">{codexAuth?.expiresAt || '-'}</span></div>
            <div className="md:col-span-2">auth path: <code className="text-gray-400">{codexAuth?.authPath || '~/.pi/agent/auth.json'}</code></div>
          </div>
          {codexAuth?.latestUsage?.rateLimits && (
            <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2 text-[13px]">
              <div className="rounded-md bg-surface-900 border border-surface-700 px-3 py-2">
                <div className="text-gray-600">5-hour</div>
                <div className="text-gray-200 font-medium">{codexAuth.latestUsage.rateLimits.primary?.used_percent ?? 0}% used</div>
              </div>
              <div className="rounded-md bg-surface-900 border border-surface-700 px-3 py-2">
                <div className="text-gray-600">weekly</div>
                <div className="text-gray-200 font-medium">{codexAuth.latestUsage.rateLimits.secondary?.used_percent ?? 0}% used</div>
              </div>
              <div className="rounded-md bg-surface-900 border border-surface-700 px-3 py-2">
                <div className="text-gray-600">last snapshot</div>
                <div className="text-gray-200 font-medium truncate">{codexAuth.latestUsage.ts || '-'}</div>
              </div>
            </div>
          )}
          {codexAuth?.planType === 'free' && (
            <div className="tone-card tone-warning text-[13px] rounded-md px-3 py-2">
              현재 OAuth claim은 free입니다. Pro 계정으로 다시 로그인해야 Codex Pro 경로가 정상화됩니다.
            </div>
          )}
          <div className="text-[13px] text-gray-600">
            로그인/재로그인: <code className="text-gray-400">cd ~/.pi/agent && node ~/tower/packages/backend/node_modules/@earendil-works/pi-ai/dist/cli.js login openai-codex</code>
          </div>
        </div>
      </div>

      {/* ── Legacy fallback accounts section ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="text-[15px] text-gray-400">
            {t('accountsRegistered', { count: accounts.length })}
            {defaultAccount && (
              <span className="ml-2 text-primary-400/70">{t('defaultAccount', { label: defaultAccount.label })}</span>
            )}
          </div>
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-3 py-1.5 text-[14px] font-medium bg-primary-600 hover:bg-primary-500 text-white rounded-lg transition-colors"
          >
            {showForm ? t('common:cancel') : t('addAccount')}
          </button>
        </div>

        {/* Add form */}
        {showForm && (
          <div className="bg-surface-800 border border-surface-700 rounded-lg p-4 mb-3 space-y-3">
            {error && <div className="text-red-400 text-[14px]">{error}</div>}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[13px] text-gray-500 block mb-1">{t('idSlug')}</label>
                <input
                  value={newAccount.id} onChange={e => setNewAccount({ ...newAccount, id: e.target.value })}
                  placeholder={t('idSlugPlaceholder')}
                  className="w-full bg-surface-900 border border-surface-700 text-gray-200 text-[15px] rounded-lg px-3 py-2"
                />
              </div>
              <div>
                <label className="text-[13px] text-gray-500 block mb-1">{t('label')}</label>
                <input
                  value={newAccount.label} onChange={e => setNewAccount({ ...newAccount, label: e.target.value })}
                  placeholder={t('labelPlaceholder')}
                  className="w-full bg-surface-900 border border-surface-700 text-gray-200 text-[15px] rounded-lg px-3 py-2"
                />
              </div>
              <div>
                <label className="text-[13px] text-gray-500 block mb-1">{t('configDir')}</label>
                <input
                  value={newAccount.configDir} onChange={e => setNewAccount({ ...newAccount, configDir: e.target.value })}
                  placeholder={t('configDirPlaceholder')}
                  className="w-full bg-surface-900 border border-surface-700 text-gray-200 text-[15px] rounded-lg px-3 py-2 font-mono"
                />
              </div>
              <div>
                <label className="text-[13px] text-gray-500 block mb-1">{t('tier')}</label>
                <select
                  value={newAccount.tier} onChange={e => setNewAccount({ ...newAccount, tier: e.target.value })}
                  className="w-full bg-surface-900 border border-surface-700 text-gray-200 text-[15px] rounded-lg px-3 py-2"
                >
                  <option value="max">{t('tierMax')}</option>
                  <option value="pro">{t('tierPro')}</option>
                  <option value="api">{t('tierApi')}</option>
                </select>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-[14px] text-gray-400 cursor-pointer">
                <input
                  type="checkbox" checked={newAccount.isDefault}
                  onChange={e => setNewAccount({ ...newAccount, isDefault: e.target.checked })}
                  className="rounded border-surface-600"
                />
                {t('setAsDefault')}
              </label>
              <button onClick={handleCreate}
                className="tone-action tone-success ml-auto px-4 py-1.5 text-[14px] font-medium rounded-lg transition-colors"
              >{t('common:create')}</button>
            </div>
          </div>
        )}

        {/* Account list */}
        <div className="bg-surface-800 border border-surface-700 rounded-lg divide-y divide-surface-700">
          {accounts.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-500 text-[15px]">
              {t('noAccountsHint')} <span className="text-gray-500">legacy provider config dir</span>
            </div>
          ) : accounts.map(acc => {
            const assignedProjects = projects.filter(p => p.claude_account_id === acc.id);
            const tierColors: Record<string, string> = { max: 'text-purple-400', pro: 'text-blue-400', api: 'text-gray-400' };

            return (
              <div key={acc.id} className="px-4 py-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${acc.enabled ? 'tone-success tone-bg' : 'bg-gray-600'}`} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[15px] text-gray-200 font-medium">{acc.label}</span>
                        <span className={`text-[13px] font-mono ${tierColors[acc.tier] || 'text-gray-400'}`}>{acc.tier.toUpperCase()}</span>
                        {acc.isDefault && (
                          <span className="text-[12px] font-medium px-1.5 py-0.5 rounded bg-primary-600/20 text-primary-400 border border-primary-500/30">{t('common:default').toUpperCase()}</span>
                        )}
                      </div>
                      <div className="text-[13px] text-gray-600 font-mono truncate">{acc.configDir}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-3">
                    {!acc.isDefault && (
                      <button
                        onClick={() => handleToggle(acc, 'isDefault')}
                        className="px-2 py-1 text-[13px] text-gray-500 hover:text-primary-400 hover:bg-surface-700 rounded transition-colors"
                        title={t('setAsDefault')}
                      >⭐</button>
                    )}
                    <button
                      onClick={() => handleToggle(acc, 'enabled')}
                      className={`px-2 py-1 text-[13px] rounded transition-colors ${
                        acc.enabled ? 'tone-success tone-text hover:text-red-400 hover:bg-surface-700' : 'text-gray-600 hover:text-primary-400 hover:bg-surface-700'
                      }`}
                    >{acc.enabled ? t('common:on') : t('common:off')}</button>
                    <button
                      onClick={() => handleDelete(acc.id)}
                      className="px-2 py-1 text-[13px] text-gray-600 hover:text-red-400 hover:bg-surface-700 rounded transition-colors"
                      title={t('common:delete')}
                    >✕</button>
                  </div>
                </div>
                {assignedProjects.length > 0 && (
                  <div className="mt-1.5 ml-5 flex flex-wrap gap-1">
                    {assignedProjects.map(p => (
                      <span key={p.id} className="text-[12px] px-1.5 py-0.5 rounded bg-surface-700 text-gray-400">{p.name}</span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Project Assignment Section ── */}
      <div>
        <h3 className="text-[15px] font-medium text-gray-300 mb-3">{t('projectAccountAssignment')}</h3>
        <div className="bg-surface-800 border border-surface-700 rounded-lg divide-y divide-surface-700 max-h-[300px] overflow-y-auto">
          {projects.map(proj => {
            const assigned = getAccountForProject(proj);
            const isAssigning = assigningProject === proj.id;

            return (
              <div key={proj.id} className="px-4 py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="text-[15px] text-gray-300 truncate">{proj.name}</span>
                </div>
                <div className="shrink-0 ml-3">
                  {isAssigning ? (
                    <select
                      autoFocus
                      value={proj.claude_account_id || ''}
                      onChange={e => handleAssign(proj.id, e.target.value || null)}
                      onBlur={() => setAssigningProject(null)}
                      className="bg-surface-900 border border-primary-500/50 text-gray-200 text-[14px] rounded px-2 py-1 w-44"
                    >
                      <option value="">{t('useDefault')}</option>
                      {accounts.filter(a => a.enabled).map(a => (
                        <option key={a.id} value={a.id}>{a.label}{a.isDefault ? ' ⭐' : ''}</option>
                      ))}
                    </select>
                  ) : (
                    <button
                      onClick={() => setAssigningProject(proj.id)}
                      className={`text-[14px] px-2 py-1 rounded transition-colors ${
                        assigned
                          ? 'text-primary-400 hover:bg-surface-700'
                          : 'text-gray-600 hover:text-gray-400 hover:bg-surface-700'
                      }`}
                    >
                      {assigned ? assigned.label : defaultAccount ? `(${defaultAccount.label})` : t('noneFallback')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {defaultAccount && (
          <div className="mt-2 text-[13px] text-gray-600">
            {t('unassignedHintFull')} <span className="text-gray-400">{defaultAccount.label}</span>
          </div>
        )}
      </div>
    </div>
  );
}
