import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '../../hooks/useDialog';
import { toastError, toastSuccess } from '../../utils/toast';

type AgentConnection = {
  id: string;
  source: 'profile' | 'credential' | 'group';
  displayName: string;
  provider: string;
  connectionType: string;
  capabilities: string[];
  status: 'available' | 'connected' | 'blocked';
  mode: 'allow' | 'deny' | null;
  updatedAt: string | null;
  fieldCount?: number;
  connectedFieldCount?: number;
};

type AgentConnectionCatalog = {
  project: { id: string; name: string };
  connections: AgentConnection[];
};

type ConnectionPreview = {
  intentId: string;
  proposalHash: string;
  expiresAt: string;
  action: 'connect' | 'disconnect';
  connection: { id: string; displayName: string; provider: string; capabilities: string[] };
  project: { id: string; name: string };
  impact: string;
  risk: 'low' | 'medium' | 'high';
};

function authHeaders(json = false): Record<string, string> {
  const token = localStorage.getItem('token');
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export function AgentConnectionsPanel({ projectId, spacious = false }: { projectId: string; spacious?: boolean }) {
  const { t } = useTranslation('layout');
  const confirm = useConfirm();
  const [catalog, setCatalog] = useState<AgentConnectionCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [changingId, setChangingId] = useState<string | null>(null);
  const [connectingGoogle, setConnectingGoogle] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/credential-vault/projects/${encodeURIComponent(projectId)}/connections/catalog`, { headers: authHeaders() });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || t('connectionCatalogLoadFailed'));
      setCatalog(body);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('connectionCatalogLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => { void load(); }, [load]);
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
    params.delete('oauth');
    params.delete('status');
    params.delete('projectId');
    params.delete('credentialId');
    params.delete('message');
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
  }, [load, projectId, t]);

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

  const changeConnection = async (connection: AgentConnection) => {
    const action = connection.status === 'connected' ? 'disconnect' : 'connect';
    setChangingId(connection.id);
    try {
      const previewResponse = await fetch(`/api/credential-vault/connections/${encodeURIComponent(connection.id)}/preview`, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ projectId, action }),
      });
      const preview = await previewResponse.json().catch(() => ({})) as ConnectionPreview & { error?: string };
      if (!previewResponse.ok) throw new Error(preview.error || t('connectionPreviewFailed'));

      const approved = await confirm({
        title: action === 'connect' ? t('connectOrganizationConnection') : t('blockAgentConnection'),
        message: `${preview.impact}\n\n${t('connectionSecretSafetyNotice')}`,
        confirmLabel: action === 'connect' ? t('connect') : t('blockUse'),
        danger: action === 'disconnect',
      });
      if (!approved) return;

      const applyResponse = await fetch(`/api/credential-vault/connections/${encodeURIComponent(connection.id)}/apply`, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ intentId: preview.intentId, proposalHash: preview.proposalHash, confirmed: true }),
      });
      const result = await applyResponse.json().catch(() => ({}));
      if (!applyResponse.ok) throw new Error(result.error || t('connectionApplyFailed'));
      toastSuccess(action === 'connect' ? t('connectionConnected') : t('connectionBlocked'));
      await load();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t('connectionApplyFailed');
      setError(message);
      toastError(message);
    } finally {
      setChangingId(null);
    }
  };

  if (loading) return <div className="text-[13px] text-surface-500">{t('loadingConnections')}</div>;

  return (
    <div className={spacious ? 'grid gap-3 sm:grid-cols-2' : 'space-y-2'}>
      <div className={`rounded-lg border border-primary-500/35 bg-surface-850/70 ${spacious ? 'flex min-h-44 flex-col p-4' : 'p-2.5'}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-surface-100">{t('agentGoogle.title')}</div>
            <div className="mt-0.5 text-[12px] leading-5 text-surface-400">{t('agentGoogle.description')}</div>
          </div>
          <span className="tone-pill tone-accent shrink-0 px-2 py-0.5 text-[11px]">{t('agentGoogle.dedicated')}</span>
        </div>
        <button
          type="button"
          onClick={() => void connectAgentGoogle()}
          disabled={connectingGoogle}
          className="tone-action tone-accent mt-auto min-h-10 w-full rounded-lg px-3 py-2 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:cursor-not-allowed disabled:bg-surface-800 disabled:text-surface-500"
        >
          {connectingGoogle ? t('agentGoogle.redirecting') : t('agentGoogle.connectOrReauthorize')}
        </button>
      </div>
      {error && <div className="tone-card tone-warning rounded-md p-2 text-[12px] sm:col-span-2">{error}</div>}
      {!catalog?.connections.length && <div className="text-[13px] text-surface-500">{t('noOrganizationConnections')}</div>}
      {catalog?.connections.map((connection) => {
        const connected = connection.status === 'connected';
        const blocked = connection.status === 'blocked';
        const statusTone = connected ? 'tone-success' : blocked ? 'tone-warning' : 'tone-muted';
        return (
          <div key={connection.id} className={`rounded-lg border border-surface-700 bg-surface-850/70 ${spacious ? 'flex min-h-44 flex-col p-4' : 'p-2.5'}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-[14px] font-semibold text-surface-200">{connection.displayName}</div>
                <div className="mt-0.5 truncate text-[12px] text-surface-500">{connection.provider}{connection.fieldCount ? ` · ${t('connectionRequiredFields', { connected: connection.connectedFieldCount ?? 0, total: connection.fieldCount })}` : ''}</div>
              </div>
              <span className={`tone-pill shrink-0 px-2 py-0.5 text-[11px] ${statusTone}`}>
                {connected ? t('connected') : blocked ? t('blocked') : t('available')}
              </span>
            </div>
            {connection.capabilities.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {connection.capabilities.slice(0, 3).map((capability) => <span key={capability} className="tone-pill tone-muted px-1.5 py-0.5 text-[11px]">{capability}</span>)}
              </div>
            )}
            <button
              type="button"
              onClick={() => void changeConnection(connection)}
              disabled={changingId !== null}
              className={`tone-action mt-2 min-h-10 w-full rounded-lg px-3 py-2 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${connected ? 'tone-warning' : 'tone-accent'} disabled:cursor-not-allowed disabled:bg-surface-800 disabled:text-surface-500`}
            >
              {changingId === connection.id ? t('changingConnection') : connected ? t('blockUse') : blocked ? t('reconnect') : t('connect')}
            </button>
          </div>
        );
      })}
      <div className={`rounded-lg border border-dashed border-surface-700 bg-surface-850/40 ${spacious ? 'flex min-h-44 flex-col p-4' : 'p-2.5'}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-surface-200">{t('mcpConnections.title')}</div>
            <div className="mt-1 text-[12px] leading-5 text-surface-500">{t('mcpConnections.description')}</div>
          </div>
          <span className="tone-pill tone-muted shrink-0 px-2 py-0.5 text-[11px]">{t('mcpConnections.comingSoon')}</span>
        </div>
        <div className="mt-auto pt-3 text-[11px] leading-4 text-surface-600">{t('mcpConnections.scopeHint')}</div>
      </div>
      <p className="text-[11px] leading-4 text-surface-500 sm:col-span-2">{t('connectionSecretSafetyNotice')}</p>
    </div>
  );
}
