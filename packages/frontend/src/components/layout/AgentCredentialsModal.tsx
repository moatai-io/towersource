import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '@tower/shared';
import { AgentConnectionsPanel } from './AgentConnectionsPanel';
import { toastError, toastSuccess } from '../../utils/toast';
import { getCurrentRole } from '../../utils/auth';

type Props = { project: Project; onClose: () => void };

type AgentCredential = {
  id: string;
  provider: string;
  display_name: string;
  kind: string;
  default_env_name: string | null;
  scope: string;
  metadata: Record<string, unknown>;
  enabled: boolean;
  rotated_at: string | null;
  updated_at: string;
  mode: 'allow' | 'deny' | 'override' | 'inherit';
  allowedActions: { reveal: boolean; inspect: boolean; replacementAction: 'rotate' | 'reauth'; reason: string };
};

type Inspection = { format: string; valid: boolean; lengthBucket: string; whitespace: string; jsonKeys?: string[]; sensitiveFieldCount?: number };

function headers(): Record<string, string> {
  const token = localStorage.getItem('token');
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeEnv(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '기록 없음';
}

export function AgentCredentialsModal({ project, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const isAdmin = getCurrentRole() === 'admin';
  const [provider, setProvider] = useState('custom');
  const [displayName, setDisplayName] = useState('');
  const [envName, setEnvName] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [credentials, setCredentials] = useState<AgentCredential[]>([]);
  const [loadingCredentials, setLoadingCredentials] = useState(true);
  const [credentialError, setCredentialError] = useState('');
  const [editing, setEditing] = useState<AgentCredential | null>(null);
  const [replacementValue, setReplacementValue] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [inspections, setInspections] = useState<Record<string, Inspection>>({});
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(null);

  const loadCredentials = useCallback(async () => {
    setLoadingCredentials(true);
    try {
      const response = await fetch(`/api/credential-vault/projects/${encodeURIComponent(project.id)}/credentials`, { headers: headers() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Agent Credential 목록을 불러오지 못했습니다.');
      setCredentials(Array.isArray(result.credentials) ? result.credentials : []);
      setCredentialError('');
    } catch (error) {
      setCredentialError(error instanceof Error ? error.message : 'Agent Credential 목록을 불러오지 못했습니다.');
    } finally {
      setLoadingCredentials(false);
    }
  }, [project.id]);

  useEffect(() => {
    closeRef.current?.focus();
    void loadCredentials();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [loadCredentials, onClose]);

  useEffect(() => {
    if (!revealed) return;
    const timeout = window.setTimeout(() => setRevealed(null), 30_000);
    return () => window.clearTimeout(timeout);
  }, [revealed]);

  const changed = () => {
    window.dispatchEvent(new CustomEvent('tower-agent-credentials-changed', { detail: { projectId: project.id } }));
    void loadCredentials();
  };

  const save = async () => {
    const resolvedEnv = normalizeEnv(envName);
    const resolvedName = displayName.trim();
    const credentialId = normalizeId(`${provider}-${resolvedEnv}`);
    if (!resolvedName || !resolvedEnv || !secretValue || !credentialId) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/credential-vault/projects/${encodeURIComponent(project.id)}/credentials/api-key`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          id: credentialId,
          provider: provider.trim().toLowerCase() || 'custom',
          displayName: resolvedName,
          secretName: resolvedEnv,
          secretValue,
          defaultEnvName: resolvedEnv,
          scope: 'project',
          metadata: { created_via: 'agent_credential_management' },
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Credential을 저장하지 못했습니다.');
      setSecretValue('');
      setDisplayName('');
      setEnvName('');
      toastSuccess(`${resolvedName}을(를) 이 Agent에 연결했습니다.`);
      changed();
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Credential을 저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const reauthenticateGoogle = async (credentialId: string) => {
    setBusyId(credentialId);
    try {
      const response = await fetch(`/api/auth/google/agent?projectId=${encodeURIComponent(project.id)}&credentialId=${encodeURIComponent(credentialId)}`, { headers: headers() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || typeof result.url !== 'string') throw new Error(result.error || 'Google 재인증을 시작하지 못했습니다.');
      window.location.assign(result.url);
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Google 재인증을 시작하지 못했습니다.');
      setBusyId(null);
    }
  };

  const rotate = async () => {
    if (!editing || !replacementValue) return;
    setBusyId(editing.id);
    try {
      const response = await fetch(`/api/credential-vault/projects/${encodeURIComponent(project.id)}/credentials/${encodeURIComponent(editing.id)}/rotate`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ secretValue: replacementValue }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Credential 값을 수정하지 못했습니다.');
      setEditing(null);
      setReplacementValue('');
      setRevealed(null);
      toastSuccess(`${editing.display_name} 값을 수정했습니다.`);
      changed();
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Credential 값을 수정하지 못했습니다.');
    } finally {
      setBusyId(null);
    }
  };

  const inspect = async (credential: AgentCredential) => {
    setBusyId(credential.id);
    try {
      const response = await fetch(`/api/credential-vault/projects/${encodeURIComponent(project.id)}/credentials/${encodeURIComponent(credential.id)}/inspect`, { method: 'POST', headers: headers() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Credential 구조를 확인하지 못했습니다.');
      setInspections(current => ({ ...current, [credential.id]: result }));
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Credential 구조를 확인하지 못했습니다.');
    } finally {
      setBusyId(null);
    }
  };

  const reveal = async (credential: AgentCredential) => {
    setBusyId(credential.id);
    try {
      const response = await fetch(`/api/credential-vault/credentials/${encodeURIComponent(credential.id)}/reveal`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ fieldId: 'secret_value', purpose: 'Agent Credential 관리' }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Credential 원문을 확인하지 못했습니다.');
      setRevealed({ id: credential.id, value: result.value });
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Credential 원문을 확인하지 못했습니다.');
    } finally {
      setBusyId(null);
    }
  };

  const ready = Boolean(displayName.trim() && normalizeEnv(envName) && secretValue);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:p-6" onMouseDown={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="agent-credentials-title" className="flex h-[min(92dvh,980px)] w-full max-w-7xl flex-col overflow-hidden rounded-2xl border border-surface-700 bg-surface-950 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-surface-800 px-5 py-4 sm:px-7 sm:py-5">
          <div>
            <div className="text-[12px] font-semibold text-primary-300">{project.agent?.displayName || project.name}</div>
            <h2 id="agent-credentials-title" className="mt-1 text-xl font-bold text-surface-100 sm:text-2xl">Credential 관리</h2>
            <p className="mt-1 text-[14px] leading-6 text-surface-400">조직 Connection과 이 Agent 전용 Credential을 한곳에서 관리합니다. Agent도 사용자 요청을 받아 안전 입력창으로 전용 Credential을 등록할 수 있습니다.</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="min-h-10 shrink-0 rounded-lg border border-surface-700 px-3 text-[14px] font-semibold text-surface-300 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">닫기</button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
            <section className="border-b border-surface-800 p-5 sm:p-7 lg:border-r">
              <h3 className="text-lg font-semibold text-surface-100">Google 및 조직 Connection</h3>
              <p className="mb-4 mt-1 text-[14px] leading-6 text-surface-400">개인 Google 계정은 이 Agent 전용으로 연결합니다. 관리자가 준비한 조직 공용 Connection은 아래에서 권한만 연결하거나 차단합니다.</p>
              <AgentConnectionsPanel projectId={project.id} spacious />
            </section>

            <section className="border-b border-surface-800 p-5 sm:p-7">
              <h3 className="text-lg font-semibold text-surface-100">새 전용 Credential 추가</h3>
              <p className="mb-5 mt-1 text-[14px] leading-6 text-surface-400">이 Agent만 사용할 API key를 저장하고 즉시 연결합니다.</p>
              <div className="space-y-4 rounded-xl border border-surface-700 bg-surface-900 p-4 sm:p-5">
                <label className="block text-[14px] font-medium text-surface-300">서비스<input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="예: openai, sub2api" className="mt-2 min-h-11 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 text-[14px] text-surface-100 outline-none placeholder:text-surface-600 focus:border-primary-400 focus-visible:ring-2 focus-visible:ring-primary-400/40" /></label>
                <label className="block text-[14px] font-medium text-surface-300">표시 이름<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="예: sub2api 운영 계정" className="mt-2 min-h-11 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 text-[14px] text-surface-100 outline-none placeholder:text-surface-600 focus:border-primary-400 focus-visible:ring-2 focus-visible:ring-primary-400/40" /></label>
                <label className="block text-[14px] font-medium text-surface-300">환경변수 이름<input value={envName} onChange={(event) => setEnvName(event.target.value)} placeholder="예: OPENAI_API_KEY" className="mt-2 min-h-11 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 font-mono text-[14px] text-surface-100 outline-none placeholder:text-surface-600 focus:border-primary-400 focus-visible:ring-2 focus-visible:ring-primary-400/40" /></label>
                <label className="block text-[14px] font-medium text-surface-300">Credential 값<textarea value={secretValue} onChange={(event) => setSecretValue(event.target.value)} placeholder="비밀값을 입력하세요" rows={4} autoComplete="off" data-1p-ignore className="mt-2 w-full resize-y rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-[14px] text-surface-100 outline-none placeholder:text-surface-600 focus:border-primary-400 focus-visible:ring-2 focus-visible:ring-primary-400/40" /></label>
                <div className="rounded-lg bg-surface-850 p-3 text-[12px] leading-5 text-surface-400">값은 채팅이나 프로젝트 파일에 저장되지 않습니다. Runtime 명령을 실행할 때만 이 Agent에 빌려줍니다.</div>
                <button type="button" disabled={!ready || saving} onClick={() => void save()} className="min-h-11 w-full rounded-lg bg-primary-600 px-4 text-[14px] font-semibold text-white hover:bg-primary-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:cursor-not-allowed disabled:bg-surface-800 disabled:text-surface-500">{saving ? '안전하게 저장하는 중…' : '이 Agent에 Credential 추가'}</button>
              </div>
            </section>
          </div>

          <section className="p-5 sm:p-7">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div><h3 className="text-lg font-semibold text-surface-100">이 Agent 전용 Credential</h3><p className="mt-1 text-[14px] leading-6 text-surface-400">현재 Agent에 귀속된 Credential의 상태·구조를 확인하고 값을 교체합니다. 원문 보기는 Admin에게만 표시됩니다.</p></div>
              <button type="button" onClick={() => void loadCredentials()} className="min-h-10 rounded-lg border border-surface-700 px-3 text-[13px] font-semibold text-surface-300 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">새로고침</button>
            </div>
            {loadingCredentials && <div className="mt-4 text-[14px] text-surface-500">Agent Credential을 불러오는 중…</div>}
            {credentialError && <div className="tone-card tone-warning mt-4 rounded-lg p-3 text-[14px]">{credentialError}</div>}
            {!loadingCredentials && !credentialError && credentials.length === 0 && <div className="mt-4 rounded-xl border border-dashed border-surface-700 p-6 text-center text-[14px] text-surface-500">아직 이 Agent 전용 Credential이 없습니다.</div>}
            <div className="mt-4 grid gap-3 xl:grid-cols-2">
              {credentials.map((credential) => {
                const inspection = inspections[credential.id];
                const isRevealed = revealed?.id === credential.id;
                return <article key={credential.id} className="rounded-xl border border-surface-700 bg-surface-900 p-4 sm:p-5">
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="truncate text-[15px] font-semibold text-surface-100">{credential.display_name}</div><div className="mt-1 truncate font-mono text-[12px] text-surface-500">{credential.default_env_name || credential.id}</div></div><span className={`tone-pill shrink-0 px-2 py-1 text-[12px] ${credential.mode === 'deny' ? 'tone-warning' : 'tone-success'}`}>{credential.mode === 'deny' ? '차단됨' : '연결됨'}</span></div>
                  <dl className="mt-4 grid gap-2 text-[13px] sm:grid-cols-2"><div><dt className="text-surface-500">서비스</dt><dd className="mt-0.5 text-surface-200">{credential.provider}</dd></div><div><dt className="text-surface-500">최근 수정</dt><dd className="mt-0.5 text-surface-200">{formatDate(credential.rotated_at || credential.updated_at)}</dd></div></dl>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {isAdmin && credential.allowedActions.reveal && <button type="button" disabled={busyId !== null} onClick={() => void reveal(credential)} className="min-h-10 rounded-lg border border-surface-700 px-3 text-[13px] font-semibold text-surface-200 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">원문 보기</button>}
                    {credential.allowedActions.replacementAction === 'reauth'
                      ? <button type="button" disabled={busyId !== null} onClick={() => void reauthenticateGoogle(credential.id)} className="min-h-10 rounded-lg bg-primary-600 px-3 text-[13px] font-semibold text-white hover:bg-primary-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">재인증</button>
                      : <button type="button" disabled={busyId !== null} onClick={() => { setEditing(credential); setReplacementValue(''); }} className="min-h-10 rounded-lg bg-primary-600 px-3 text-[13px] font-semibold text-white hover:bg-primary-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">수정하기</button>}
                    <button type="button" disabled={busyId !== null} onClick={() => void inspect(credential)} className="min-h-10 rounded-lg border border-surface-700 px-3 text-[13px] font-semibold text-surface-200 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">구조 보기</button>
                  </div>
                  {isRevealed && <div className="mt-3 rounded-lg border border-surface-700 bg-surface-950 p-3"><div className="flex items-center justify-between gap-2 text-[12px] text-surface-400"><span>원문 · 30초 후 자동 마스킹</span><button type="button" onClick={() => setRevealed(null)} className="min-h-10 px-2 font-semibold text-primary-300">지금 가리기</button></div><pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[13px] text-surface-100">{revealed.value}</pre></div>}
                  {inspection && <div className="mt-3 rounded-lg bg-surface-850 p-3 text-[12px] leading-5 text-surface-300"><div>형식: {inspection.format} · 유효: {inspection.valid ? '예' : '아니오'} · 길이: {inspection.lengthBucket}</div>{inspection.jsonKeys?.length ? <div className="mt-1">키: {inspection.jsonKeys.join(', ')}</div> : null}</div>}
                  {editing?.id === credential.id && <div className="mt-4 rounded-lg border border-primary-500/40 bg-surface-850 p-3"><label className="block text-[13px] font-semibold text-surface-200">새 Credential 값<textarea value={replacementValue} onChange={(event) => setReplacementValue(event.target.value)} rows={4} autoComplete="off" data-1p-ignore className="mt-2 w-full resize-y rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-[14px] text-surface-100 outline-none focus-visible:ring-2 focus-visible:ring-primary-400" /></label><div className="mt-3 flex gap-2"><button type="button" disabled={!replacementValue || busyId !== null} onClick={() => void rotate()} className="min-h-10 rounded-lg bg-primary-600 px-3 text-[13px] font-semibold text-white disabled:bg-surface-800 disabled:text-surface-500">새 값으로 교체</button><button type="button" onClick={() => { setEditing(null); setReplacementValue(''); }} className="min-h-10 rounded-lg border border-surface-700 px-3 text-[13px] font-semibold text-surface-300">취소</button></div></div>}
                </article>;
              })}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
