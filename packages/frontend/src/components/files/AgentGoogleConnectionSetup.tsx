import React from 'react';
import i18n from '../../i18n';
import { useTranslation } from 'react-i18next';

export interface OrganizationGoogleConnection {
  id: string;
  displayName: string;
  googleAccount: string;
}

export type AgentGoogleSetup =
  | { mode: 'none' }
  | { mode: 'organization'; credentialId: string }
  | { mode: 'dedicated' };

export interface GoogleOAuthReadiness {
  configured: boolean;
  ready: boolean;
  publicUrl: string;
  expectedRedirectUri: string;
  secureRedirect: boolean;
  redirectMatchesPublicUrl: boolean;
  reason: 'ready' | 'client_not_configured' | 'https_required' | 'redirect_uri_mismatch';
}

function authHeaders() {
  const token = localStorage.getItem('token');
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

export async function loadGoogleOAuthReadiness(): Promise<GoogleOAuthReadiness> {
  const response = await fetch('/api/auth/google/readiness', { headers: authHeaders(), cache: 'no-store' });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || i18n.t('agentCreation.google.readinessFailed', { ns: 'files' }));
  return result as GoogleOAuthReadiness;
}

export async function loadOrganizationGoogleConnections(): Promise<OrganizationGoogleConnection[]> {
  const response = await fetch('/api/credential-vault/credentials', { headers: authHeaders(), cache: 'no-store' });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) return [];
    throw new Error(result.error || i18n.t('agentCreation.google.loadFailed', { ns: 'files' }));
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
  if (!response.ok) throw new Error(result.error || i18n.t('agentCreation.google.grantFailed', { ns: 'files' }));
}

export async function startDedicatedGoogleOAuth(projectId: string): Promise<void> {
  const response = await fetch(`/api/auth/google/agent?projectId=${encodeURIComponent(projectId)}`, { headers: authHeaders() });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.url !== 'string') throw new Error(result.error || i18n.t('agentCreation.google.oauthFailed', { ns: 'files' }));
  window.location.assign(result.url);
}

export function AgentGoogleConnectionSetup({ value, onChange, connections, readiness, loading }: {
  value: AgentGoogleSetup;
  onChange: (value: AgentGoogleSetup) => void;
  connections: OrganizationGoogleConnection[];
  readiness: GoogleOAuthReadiness | null;
  loading: boolean;
}) {
  const { t } = useTranslation('files');
  const selectedOrganizationId = value.mode === 'organization' ? value.credentialId : '';
  const googleReady = readiness?.ready === true;
  const readinessMessage = readiness?.reason === 'https_required'
    ? t('agentCreation.google.httpsRequired', { publicUrl: readiness.publicUrl })
    : readiness?.reason === 'redirect_uri_mismatch'
      ? t('agentCreation.google.redirectMismatch')
      : t('agentCreation.google.setupRequired');
  return (
    <section aria-labelledby="agent-google-setup-title" className="rounded-3xl border border-surface-700 bg-surface-900 p-5">
      <h2 id="agent-google-setup-title" className="text-base font-black text-surface-100">{t('agentCreation.google.title')}</h2>
      <p className="mt-1 text-sm leading-6 text-surface-200">{t('agentCreation.google.description')}</p>
      <div className="mt-4 grid gap-2">
        <label className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 ${value.mode === 'none' ? 'border-primary-400 bg-primary-500/15' : 'border-surface-700 bg-surface-950 hover:border-surface-500'}`}>
          <input type="radio" name="agent-google-setup" checked={value.mode === 'none'} onChange={() => onChange({ mode: 'none' })} className="mt-1 accent-primary-500" />
          <span><span className="block text-sm font-bold text-surface-100">{t('agentCreation.google.none')}</span><span className="mt-0.5 block text-xs leading-5 text-surface-200">{t('agentCreation.google.noneDescription')}</span></span>
        </label>
        <label className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 ${value.mode === 'organization' ? 'border-primary-400 bg-primary-500/15' : 'border-surface-700 bg-surface-950 hover:border-surface-500'}`}>
          <input type="radio" name="agent-google-setup" checked={value.mode === 'organization'} disabled={loading || !googleReady || connections.length === 0} onChange={() => connections[0] && onChange({ mode: 'organization', credentialId: connections[0].id })} className="mt-1 accent-primary-500" />
          <span className="min-w-0 flex-1"><span className="block text-sm font-bold text-surface-100">{t('agentCreation.google.organization')}</span><span className="mt-0.5 block text-xs leading-5 text-surface-200">{t('agentCreation.google.organizationDescription')}</span>
            {loading ? <span className="mt-2 block text-xs text-surface-500">{t('agentCreation.google.loading')}</span> : connections.length ? (
              <select aria-label={t('agentCreation.google.organizationAria')} value={selectedOrganizationId || connections[0].id} onChange={(event) => onChange({ mode: 'organization', credentialId: event.target.value })} onClick={(event) => event.stopPropagation()} className="mt-2 min-h-10 w-full rounded-xl border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-surface-100 outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-500/20">
                {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.googleAccount || connection.displayName}</option>)}
              </select>
            ) : <span className="mt-2 block text-xs text-surface-500">{t('agentCreation.google.empty')}</span>}
          </span>
        </label>
        <label className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 ${value.mode === 'dedicated' ? 'border-primary-400 bg-primary-500/15' : 'border-surface-700 bg-surface-950 hover:border-surface-500'}`}>
          <input type="radio" name="agent-google-setup" checked={value.mode === 'dedicated'} disabled={loading || !googleReady} onChange={() => onChange({ mode: 'dedicated' })} className="mt-1 accent-primary-500" />
          <span><span className="block text-sm font-bold text-surface-100">{t('agentCreation.google.dedicated')}</span><span className="mt-0.5 block text-xs leading-5 text-surface-200">{t('agentCreation.google.dedicatedDescription')}</span></span>
        </label>
        {!loading && !googleReady && (
          <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 p-4 text-xs leading-5 text-amber-100">
            <div className="font-bold">{readinessMessage}</div>
            {readiness?.expectedRedirectUri && (
              <div className="mt-2">
                <div className="text-amber-200/80">{t('agentCreation.google.callbackLabel')}</div>
                <code className="mt-1 block overflow-x-auto rounded-lg bg-black/25 px-2 py-1.5 text-[11px] text-amber-50">{readiness.expectedRedirectUri}</code>
              </div>
            )}
            <div className="mt-2 text-amber-200/80">{t('agentCreation.google.adminSetupHint')}</div>
          </div>
        )}
      </div>
    </section>
  );
}
