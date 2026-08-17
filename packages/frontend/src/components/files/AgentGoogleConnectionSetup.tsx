import React from 'react';

export interface OrganizationGoogleConnection {
  id: string;
  displayName: string;
  googleAccount: string;
}

export type AgentGoogleSetup =
  | { mode: 'none' }
  | { mode: 'organization'; credentialId: string }
  | { mode: 'dedicated' };

function authHeaders() {
  const token = localStorage.getItem('token');
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

export async function loadOrganizationGoogleConnections(): Promise<OrganizationGoogleConnection[]> {
  const response = await fetch('/api/credential-vault/credentials', { headers: authHeaders(), cache: 'no-store' });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) return [];
    throw new Error(result.error || '조직 Google Connection을 불러오지 못했습니다.');
  }
  return (Array.isArray(result.credentials) ? result.credentials : [])
    .filter((credential: any) => credential?.enabled === true && credential?.kind === 'gws' && credential?.provider === 'google' && credential?.metadata?.connection_type === 'organization')
    .map((credential: any) => ({
      id: String(credential.id),
      displayName: String(credential.display_name || credential.id),
      googleAccount: String(credential.metadata?.google_account || ''),
    }));
}

export async function allowOrganizationGoogleConnection(projectId: string, credentialId: string): Promise<void> {
  const response = await fetch(`/api/credential-vault/projects/${encodeURIComponent(projectId)}/policies/${encodeURIComponent(credentialId)}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ mode: 'allow', metadata: { granted_via: 'agent_creation' } }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Agent는 생성됐지만 조직 Google 계정 연결에 실패했습니다.');
}

export function startDedicatedGoogleOAuth(projectId: string): void {
  window.location.href = `/api/auth/google/agent?projectId=${encodeURIComponent(projectId)}`;
}

export function AgentGoogleConnectionSetup({ value, onChange, connections, loading }: {
  value: AgentGoogleSetup;
  onChange: (value: AgentGoogleSetup) => void;
  connections: OrganizationGoogleConnection[];
  loading: boolean;
}) {
  const selectedOrganizationId = value.mode === 'organization' ? value.credentialId : '';
  return (
    <section aria-labelledby="agent-google-setup-title" className="rounded-3xl border border-surface-700 bg-surface-900 p-5">
      <h2 id="agent-google-setup-title" className="text-base font-black text-surface-100">Google Workspace 연결</h2>
      <p className="mt-1 text-sm leading-6 text-surface-200">필요한 계정만 선택하세요. 선택하지 않은 조직 계정은 이 Agent에 자동으로 허용되지 않습니다.</p>
      <div className="mt-4 grid gap-2">
        <label className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 ${value.mode === 'none' ? 'border-primary-400 bg-primary-500/15' : 'border-surface-700 bg-surface-950 hover:border-surface-500'}`}>
          <input type="radio" name="agent-google-setup" checked={value.mode === 'none'} onChange={() => onChange({ mode: 'none' })} className="mt-1 accent-primary-500" />
          <span><span className="block text-sm font-bold text-surface-100">연결하지 않음</span><span className="mt-0.5 block text-xs leading-5 text-surface-200">최소 권한으로 만들고 나중에 Connections에서 설정합니다.</span></span>
        </label>
        <label className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 ${value.mode === 'organization' ? 'border-primary-400 bg-primary-500/15' : 'border-surface-700 bg-surface-950 hover:border-surface-500'}`}>
          <input type="radio" name="agent-google-setup" checked={value.mode === 'organization'} disabled={loading || connections.length === 0} onChange={() => connections[0] && onChange({ mode: 'organization', credentialId: connections[0].id })} className="mt-1 accent-primary-500" />
          <span className="min-w-0 flex-1"><span className="block text-sm font-bold text-surface-100">조직 계정 사용</span><span className="mt-0.5 block text-xs leading-5 text-surface-200">관리자가 연결해 둔 계정 중 하나를 이 Agent에 허용합니다.</span>
            {loading ? <span className="mt-2 block text-xs text-surface-500">계정 목록 불러오는 중…</span> : connections.length ? (
              <select aria-label="조직 Google 계정" value={selectedOrganizationId || connections[0].id} onChange={(event) => onChange({ mode: 'organization', credentialId: event.target.value })} onClick={(event) => event.stopPropagation()} className="mt-2 min-h-10 w-full rounded-xl border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-surface-100 outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-500/20">
                {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.googleAccount || connection.displayName}</option>)}
              </select>
            ) : <span className="mt-2 block text-xs text-surface-500">사용 가능한 조직 Google 계정이 없습니다.</span>}
          </span>
        </label>
        <label className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 ${value.mode === 'dedicated' ? 'border-primary-400 bg-primary-500/15' : 'border-surface-700 bg-surface-950 hover:border-surface-500'}`}>
          <input type="radio" name="agent-google-setup" checked={value.mode === 'dedicated'} onChange={() => onChange({ mode: 'dedicated' })} className="mt-1 accent-primary-500" />
          <span><span className="block text-sm font-bold text-surface-100">이 Agent 전용 Google 계정 연결</span><span className="mt-0.5 block text-xs leading-5 text-surface-200">Agent를 만든 직후 Google 로그인 화면으로 이동합니다.</span></span>
        </label>
      </div>
    </section>
  );
}
