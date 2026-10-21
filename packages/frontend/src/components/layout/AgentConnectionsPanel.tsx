import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toastError, toastSuccess } from '../../utils/toast';

type AgentConnection = {
  id: string;
  displayName: string;
  provider: string;
  connectionType: string;
  capabilities: string[];
  status: 'available' | 'connected' | 'blocked';
  origin?: 'agent' | 'organization';
  updatedAt: string | null;
  fieldCount?: number;
  connectedFieldCount?: number;
  credentialId?: string;
  canReveal?: boolean;
};

type ImportCandidate = {
  credentialId: string;
  displayName: string;
  provider: string;
  projectId: string;
  projectName: string;
};

type AgentConnectionCatalog = {
  project?: { id: string; name: string };
  projectId?: string;
  connections: AgentConnection[];
};

function authHeaders(json = false): Record<string, string> {
  const token = localStorage.getItem('token');
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export function AgentConnectionsPanel({ projectId, spacious = false, hideAgentConnections = false, view = 'all' }: { projectId: string; spacious?: boolean; hideAgentConnections?: boolean; view?: 'all' | 'shared' | 'google' | 'import' }) {
  const { t } = useTranslation('layout');
  const [catalog, setCatalog] = useState<AgentConnectionCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [connectingGoogle, setConnectingGoogle] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealingId, setRevealingId] = useState('');
  const [importCandidates, setImportCandidates] = useState<ImportCandidate[]>([]);
  const [selectedImport, setSelectedImport] = useState('');
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/credential-vault/projects/${encodeURIComponent(projectId)}/connections/catalog`, { headers: authHeaders() });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || t('connectionCatalogLoadFailed'));
      const connections = Array.isArray(body.connections) ? body.connections.map((connection: any): AgentConnection => ({
        id: String(connection.id || ''),
        displayName: String(connection.displayName || connection.credentialId || connection.id || ''),
        provider: String(connection.provider || 'custom'),
        connectionType: String(connection.kind || connection.connectionType || 'credential'),
        capabilities: Array.isArray(connection.capabilities) ? connection.capabilities : [],
        status: connection.status === 'blocked' ? 'blocked' : connection.status === 'available' ? 'available' : 'connected',
        origin: connection.connectionScope === 'agent_dedicated' || connection.scope === 'project' ? 'agent' : 'organization',
        updatedAt: connection.updatedAt ?? null,
        fieldCount: connection.fieldCount,
        connectedFieldCount: connection.connectedFieldCount,
        credentialId: String(connection.credentialId || '').trim() || undefined,
        canReveal: connection.canReveal === true,
      })) : [];
      setCatalog({ ...body, connections });
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('connectionCatalogLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void fetch(`/api/credential-vault/projects/${encodeURIComponent(projectId)}/credentials/import-candidates`, { headers: authHeaders() })
      .then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || t('connectionImportLoadFailed'));
        setImportCandidates(Array.isArray(body.candidates) ? body.candidates : []);
      })
      .catch(reason => setError(reason instanceof Error ? reason.message : t('connectionImportLoadFailed')));
  }, [projectId, t]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('oauth') !== 'google-agent' || params.get('projectId') !== projectId) return;
    if (params.get('status') === 'success') {
      toastSuccess(t('agentGoogle.connected'));
      window.dispatchEvent(new CustomEvent('tower-agent-credentials-changed', { detail: { projectId } }));
      void load();
    } else {
      toastError(t('agentGoogle.connectFailed'));
    }
    for (const key of ['oauth', 'status', 'projectId', 'credentialId', 'message']) params.delete(key);
    const query = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  }, [load, projectId, t]);
  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (!detail?.projectId || detail.projectId === projectId) void load();
    };
    window.addEventListener('tower-agent-credentials-changed', refresh);
    return () => window.removeEventListener('tower-agent-credentials-changed', refresh);
  }, [load, projectId]);

  const revealConnection = async (connection: AgentConnection) => {
    const credentialId = connection.credentialId;
    if (!credentialId) return;
    if (revealed[credentialId] !== undefined) {
      setRevealed(current => { const next = { ...current }; delete next[credentialId]; return next; });
      return;
    }
    setRevealingId(credentialId);
    try {
      const response = await fetch(`/api/credential-vault/projects/${encodeURIComponent(projectId)}/credentials/${encodeURIComponent(credentialId)}/reveal`, {
        method: 'POST', headers: authHeaders(true), body: JSON.stringify({ purpose: 'Agent Connections value review' }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.value !== 'string') throw new Error(body.error || t('connectionRevealFailed'));
      setRevealed(current => ({ ...current, [credentialId]: body.value }));
    } catch (reason) {
      toastError(reason instanceof Error ? reason.message : t('connectionRevealFailed'));
    } finally { setRevealingId(''); }
  };

  const importConnection = async () => {
    const candidate = importCandidates.find(item => `${item.projectId}:${item.credentialId}` === selectedImport);
    if (!candidate) return;
    setImporting(true);
    try {
      const response = await fetch(`/api/credential-vault/projects/${encodeURIComponent(projectId)}/credentials/import`, {
        method: 'POST', headers: authHeaders(true), body: JSON.stringify({ sourceProjectId: candidate.projectId, sourceCredentialId: candidate.credentialId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || t('connectionImportFailed'));
      toastSuccess(t('connectionImportSucceeded'));
      setSelectedImport('');
      window.dispatchEvent(new CustomEvent('tower-agent-credentials-changed', { detail: { projectId } }));
      await load();
    } catch (reason) {
      toastError(reason instanceof Error ? reason.message : t('connectionImportFailed'));
    } finally { setImporting(false); }
  };

  const connectAgentGoogle = async () => {
    setConnectingGoogle(true);
    try {
      const response = await fetch(`/api/auth/google/agent?projectId=${encodeURIComponent(projectId)}`, { headers: authHeaders() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || typeof result.url !== 'string') throw new Error(result.error || t('agentGoogle.startFailed'));
      window.location.assign(result.url);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t('agentGoogle.startFailed');
      setError(message);
      toastError(message);
      setConnectingGoogle(false);
    }
  };

  if (loading) return <div className="text-[13px] text-surface-500">{t('loadingConnections')}</div>;

  const agentConnections = catalog?.connections.filter(connection => connection.origin === 'agent') ?? [];
  const organizationConnections = catalog?.connections.filter(connection => connection.origin !== 'agent') ?? [];
  const renderConnection = (connection: AgentConnection, shared: boolean) => {
    const connected = connection.status === 'connected';
    const blocked = connection.status === 'blocked';
    const statusTone = connected ? 'tone-success' : blocked ? 'tone-warning' : 'tone-muted';
    return (
      <div key={connection.id} className={`rounded-lg border border-surface-700 bg-surface-850/70 ${spacious ? 'flex min-h-40 flex-col p-4' : 'p-2.5'}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold text-surface-200">{connection.displayName}</div>
            <div className="mt-0.5 truncate text-[12px] text-surface-500">{connection.provider}{connection.fieldCount ? ` · ${t('connectionRequiredFields', { connected: connection.connectedFieldCount ?? 0, total: connection.fieldCount })}` : ''}</div>
          </div>
          <span className={`tone-pill shrink-0 px-2 py-0.5 text-[11px] ${statusTone}`}>{connected ? t('connected') : blocked ? t('blocked') : t('available')}</span>
        </div>
        {connection.capabilities.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{connection.capabilities.slice(0, 3).map(capability => <span key={capability} className="tone-pill tone-muted px-1.5 py-0.5 text-[11px]">{capability}</span>)}</div>}
        {connection.credentialId && revealed[connection.credentialId] !== undefined && <div className="mt-3 break-all rounded-md bg-surface-950 px-2.5 py-2 font-mono text-[12px] text-surface-200">{revealed[connection.credentialId]}</div>}
        {connection.canReveal && <button type="button" onClick={() => void revealConnection(connection)} disabled={revealingId === connection.credentialId} className="tone-action tone-muted mt-3 rounded-md px-2.5 py-1.5 text-[12px] font-medium disabled:opacity-50">{connection.credentialId && revealed[connection.credentialId] !== undefined ? t('connectionHideValue') : revealingId === connection.credentialId ? t('connectionRevealing') : t('connectionRevealValue')}</button>}
        {shared && <div className="mt-auto pt-3 text-[11px] leading-4 text-surface-500">{t('agentCredentials.managedByAdmin')}</div>}
      </div>
    );
  };

  return (
    <div className={spacious ? 'space-y-5' : 'space-y-3'}>
      {view !== 'shared' && <p className="text-[12px] leading-5 text-surface-400" data-testid="agent-connection-authority-notice">{t('agentConnectionAuthorityNotice')}</p>}
      {(view === 'all' || view === 'google') && <section>
        <div className="mb-2"><h4 className="text-[14px] font-semibold text-surface-100">{t(hideAgentConnections ? 'agentGoogle.addAccountTitle' : 'agentGoogle.agentAccountsTitle')}</h4><p className="mt-0.5 text-[12px] leading-5 text-surface-500">{t('agentGoogle.agentAccountsDescription')}</p></div>
        <div className={spacious ? 'grid gap-3 sm:grid-cols-2' : 'space-y-2'}>
          <div className={`rounded-lg border border-primary-500/35 bg-surface-850/70 ${spacious ? 'flex min-h-40 flex-col p-4' : 'p-2.5'}`}>
            <div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="text-[14px] font-semibold text-surface-100">{t('agentGoogle.title')}</div><div className="mt-0.5 text-[12px] leading-5 text-surface-400">{t('agentGoogle.description')}</div></div><span className="tone-pill tone-accent shrink-0 px-2 py-0.5 text-[11px]">{t('agentGoogle.dedicated')}</span></div>
            <button type="button" onClick={() => void connectAgentGoogle()} disabled={connectingGoogle} className="tone-action tone-accent mt-auto min-h-10 w-full rounded-lg px-3 py-2 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:cursor-not-allowed disabled:bg-surface-800 disabled:text-surface-500">{connectingGoogle ? t('agentGoogle.redirecting') : t('agentGoogle.connectOrReauthorize')}</button>
          </div>
          {!hideAgentConnections && agentConnections.map(connection => renderConnection(connection, false))}
        </div>
      </section>}
      {error && <div className="tone-card tone-warning rounded-md p-2 text-[12px]">{error}</div>}
      {(view === 'all' || view === 'import') && <section>
        <div className="mb-2"><h4 className="text-[14px] font-semibold text-surface-100">{t('connectionImportTitle')}</h4><p className="mt-0.5 text-[12px] leading-5 text-surface-500">{t('connectionImportDescription')}</p></div>
        <div className="flex gap-2">
          <select value={selectedImport} onChange={event => setSelectedImport(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-surface-700 bg-surface-850 px-3 py-2 text-[12px] text-surface-200">
            <option value="">{t('connectionImportPlaceholder')}</option>
            {importCandidates.map(candidate => <option key={`${candidate.projectId}:${candidate.credentialId}`} value={`${candidate.projectId}:${candidate.credentialId}`}>{candidate.projectName} · {candidate.displayName} ({candidate.provider})</option>)}
          </select>
          <button type="button" onClick={() => void importConnection()} disabled={!selectedImport || importing} className="tone-action tone-accent rounded-lg px-3 py-2 text-[12px] font-semibold disabled:opacity-50">{importing ? t('connectionImporting') : t('connectionImportAction')}</button>
        </div>
      </section>}
      {(view === 'all' || view === 'shared') && <section>
        <div className="mb-2"><h4 className="text-[14px] font-semibold text-surface-100">{t('agentGoogle.organizationAccountsTitle')}</h4><p className="mt-0.5 text-[12px] leading-5 text-surface-500">{t('agentGoogle.organizationAccountsDescription')}</p></div>
        <div className={spacious ? 'grid gap-3 sm:grid-cols-2' : 'space-y-2'}>
          {!organizationConnections.length && <div className="text-[13px] text-surface-500">{t('noOrganizationConnections')}</div>}
          {organizationConnections.map(connection => renderConnection(connection, true))}
        </div>
      </section>}
      <p className="text-[11px] leading-4 text-surface-500">{t('connectionSecretSafetyNotice')}</p>
    </div>
  );
}
