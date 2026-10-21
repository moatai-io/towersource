import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import type { Project } from '@tower/shared';
import { AgentConnectionsPanel } from './AgentConnectionsPanel';
import { toastError, toastSuccess } from '../../utils/toast';
import { useConfirm } from '../../hooks/useDialog';
import { usePrompt } from '../../hooks/useDialog';

type Props = { project: Project; onClose: () => void };

type AgentCredential = {
  id: string;
  provider: string;
  display_name: string;
  default_env_name: string | null;
  enabled: boolean;
  rotated_at: string | null;
  updated_at: string;
  allowedActions?: { replacementAction?: 'rotate' | 'reauth' };
};

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
  return value ? new Date(value).toLocaleString(i18n.resolvedLanguage || i18n.language) : i18n.t('layout:agentCredentials.noRecord');
}

export function AgentCredentialsModal({ project, onClose }: Props) {
  const { t } = useTranslation('layout');
  const confirm = useConfirm();
  const prompt = usePrompt();
  const closeRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLElement>(null);
  const [adding, setAdding] = useState(false);
  const [addMethod, setAddMethod] = useState<'google' | 'api' | 'import'>('google');
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

  const loadCredentials = useCallback(async () => {
    setLoadingCredentials(true);
    try {
      const response = await fetch(`/api/credential-vault/projects/${encodeURIComponent(project.id)}/credentials`, { headers: headers() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || t('agentCredentials.loadFailed'));
      setCredentials(Array.isArray(result.credentials) ? result.credentials : []);
      setCredentialError('');
    } catch (error) {
      setCredentialError(error instanceof Error ? error.message : t('agentCredentials.loadFailed'));
    } finally {
      setLoadingCredentials(false);
    }
  }, [project.id, t]);

  useEffect(() => {
    closeRef.current?.focus();
    void loadCredentials();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [loadCredentials, onClose]);

  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent<{ projectId?: string }>).detail?.projectId === project.id) void loadCredentials();
    };
    window.addEventListener('tower-agent-credentials-changed', refresh);
    return () => window.removeEventListener('tower-agent-credentials-changed', refresh);
  }, [loadCredentials, project.id]);

  useEffect(() => {
    if (adding) {
      addRef.current?.scrollIntoView?.({ block: 'nearest' });
      addRef.current?.focus();
    }
  }, [adding]);

  const changed = () => {
    window.dispatchEvent(new CustomEvent('tower-agent-credentials-changed', { detail: { projectId: project.id } }));
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
      if (!response.ok) throw new Error(result.error || t('agentCredentials.saveFailed'));
      setSecretValue('');
      setAdding(false);
      setDisplayName('');
      setEnvName('');
      toastSuccess(t('agentCredentials.connectedToast', { name: resolvedName }));
      changed();
    } catch (error) {
      toastError(error instanceof Error ? error.message : t('agentCredentials.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const reauthenticateGoogle = async (credentialId: string) => {
    setBusyId(credentialId);
    try {
      const response = await fetch(`/api/auth/google/agent?projectId=${encodeURIComponent(project.id)}&credentialId=${encodeURIComponent(credentialId)}`, { headers: headers() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || typeof result.url !== 'string') throw new Error(result.error || t('agentCredentials.googleReauthFailed'));
      window.location.assign(result.url);
    } catch (error) {
      toastError(error instanceof Error ? error.message : t('agentCredentials.googleReauthFailed'));
      setBusyId(null);
    }
  };

  const rotate = async () => {
    if (!editing || !replacementValue) return;
    setBusyId(editing.id);
    try {
      // Backend contract: Agent-owned Credential replacement is immediate and
      // keeps the existing Agent binding; raw values are never returned.
      const response = await fetch(`/api/credential-vault/projects/${encodeURIComponent(project.id)}/credentials/${encodeURIComponent(editing.id)}/rotate`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ secretValue: replacementValue }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || t('agentCredentials.updateFailed'));
      const name = editing.display_name;
      setEditing(null);
      setReplacementValue('');
      toastSuccess(t('agentCredentials.updatedToast', { name }));
      changed();
    } catch (error) {
      toastError(error instanceof Error ? error.message : t('agentCredentials.updateFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const setEnabled = async (credential: AgentCredential, enabled: boolean) => {
    setBusyId(credential.id);
    try {
      // Use the canonical Agent-scoped lifecycle endpoint.
      const response = await fetch(`/api/credential-vault/projects/${encodeURIComponent(project.id)}/credentials/${encodeURIComponent(credential.id)}`, {
        method: 'PATCH', headers: headers(), body: JSON.stringify({ enabled }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || t('agentCredentials.statusFailed'));
      toastSuccess(t(enabled ? 'agentCredentials.enabledToast' : 'agentCredentials.disabledToast', { name: credential.display_name }));
      changed();
    } catch (error) {
      toastError(error instanceof Error ? error.message : t('agentCredentials.statusFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const rename = async (credential: AgentCredential) => {
    const name = await prompt({ message: t('agentCredentials.rename'), initialValue: credential.display_name });
    if (!name?.trim() || name.trim() === credential.display_name) return;
    setBusyId(credential.id);
    try {
      const response = await fetch(`/api/credential-vault/projects/${encodeURIComponent(project.id)}/credentials/${encodeURIComponent(credential.id)}`, {
        method: 'PATCH', headers: headers(), body: JSON.stringify({ displayName: name.trim() }),
      });
      if (!response.ok) throw new Error(t('agentCredentials.updateFailed'));
      changed();
    } catch (error) { toastError(error instanceof Error ? error.message : t('agentCredentials.updateFailed')); }
    finally { setBusyId(null); }
  };

  const remove = async (credential: AgentCredential) => {
    const approved = await confirm({
      title: t('agentCredentials.deleteConfirmTitle'),
      message: t('agentCredentials.deleteConfirmMessage', { name: credential.display_name }),
      confirmLabel: t('agentCredentials.delete'),
      danger: true,
    });
    if (!approved) return;
    const finalApproved = await confirm({
      title: t('agentCredentials.deleteFinalConfirmTitle'),
      message: t('agentCredentials.deleteFinalConfirmMessage', { name: credential.display_name }),
      confirmLabel: t('agentCredentials.deletePermanently'),
      danger: true,
    });
    if (!finalApproved) return;
    setBusyId(credential.id);
    try {
      // Expected backend contract: deletes this Agent-owned Connection only.
      const response = await fetch(`/api/credential-vault/projects/${encodeURIComponent(project.id)}/credentials/${encodeURIComponent(credential.id)}`, {
        method: 'DELETE', headers: headers(),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || t('agentCredentials.deleteFailed'));
      toastSuccess(t('agentCredentials.deletedToast', { name: credential.display_name }));
      changed();
    } catch (error) {
      toastError(error instanceof Error ? error.message : t('agentCredentials.deleteFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const ready = Boolean(displayName.trim() && normalizeEnv(envName) && secretValue);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:p-6" onMouseDown={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="agent-credentials-title" className="flex h-[min(92dvh,980px)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-surface-700 bg-surface-950 shadow-2xl" onMouseDown={event => event.stopPropagation()}>
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-surface-800 px-5 py-4 sm:px-7 sm:py-5">
          <div><div className="text-[12px] font-semibold text-primary-300">{project.agent?.displayName || project.name}</div><h2 id="agent-credentials-title" className="mt-1 text-xl font-bold text-surface-100 sm:text-2xl">{t('agentCredentials.title')}</h2><p className="mt-1 text-[14px] leading-6 text-surface-400">{t('agentCredentials.description')}</p></div>
          <button type="button" onClick={() => { setAdding(value => !value); setSecretValue(''); }} aria-expanded={adding} className="tone-action tone-accent min-h-10 shrink-0 rounded-lg px-3 text-[14px] font-semibold">{t(adding ? 'agentCredentials.cancel' : 'agentCredentials.addConnection')}</button>
          <button ref={closeRef} type="button" onClick={onClose} className="min-h-10 shrink-0 rounded-lg border border-surface-700 px-3 text-[14px] font-semibold text-surface-300 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">{t('agentCredentials.close')}</button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <section className="p-5 sm:p-7">
            <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 className="text-lg font-semibold text-surface-100">{t('agentCredentials.listTitle')}</h3><p className="mt-1 text-[14px] leading-6 text-surface-400">{t('agentCredentials.listDescription')}</p></div><button type="button" onClick={() => void loadCredentials()} className="min-h-10 rounded-lg border border-surface-700 px-3 text-[13px] font-semibold text-surface-300 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">{t('agentCredentials.refresh')}</button></div>
            {loadingCredentials && <div className="mt-4 text-[14px] text-surface-500">{t('agentCredentials.loading')}</div>}
            {credentialError && <div className="tone-card tone-warning mt-4 rounded-lg p-3 text-[14px]">{credentialError}</div>}
            {!loadingCredentials && !credentialError && credentials.length === 0 && <div className="mt-4 rounded-xl border border-dashed border-surface-700 p-6 text-center text-[14px] text-surface-500">{t('agentCredentials.empty')}</div>}
            <div className="mt-4 divide-y divide-surface-800">{credentials.map(credential => <article key={credential.id} className="py-4">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="truncate text-[15px] font-semibold text-surface-100">{credential.display_name}</div><div className="mt-1 truncate font-mono text-[12px] text-surface-500">{credential.provider}</div></div><span className={`tone-pill shrink-0 px-2 py-1 text-[12px] ${credential.enabled ? 'tone-success' : 'tone-warning'}`}>{credential.enabled ? t('agentCredentials.connected') : t('agentCredentials.disabled')}</span></div>

              <div className="mt-4 flex flex-wrap gap-2">

                <button type="button" disabled={busyId !== null} onClick={() => void setEnabled(credential, !credential.enabled)} className="min-h-10 rounded-lg border border-surface-700 px-3 text-[13px] font-semibold text-surface-200 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">{credential.enabled ? t('agentCredentials.disable') : t('agentCredentials.enable')}</button>
                <details className="relative"><summary className="cursor-pointer rounded-lg border border-surface-700 px-3 py-2 text-[13px] text-surface-300" aria-label={t('agentCredentials.moreActions')}>{t('agentCredentials.moreActions')}</summary><div className="mt-2 flex flex-wrap gap-2">
                {credential.allowedActions?.replacementAction === 'reauth' ? <button type="button" disabled={busyId !== null} onClick={() => void reauthenticateGoogle(credential.id)} className="min-h-10 rounded-lg bg-primary-600 px-3 text-[13px] font-semibold text-white hover:bg-primary-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">{t('agentCredentials.reauthenticate')}</button> : <button type="button" disabled={busyId !== null} onClick={() => { setEditing(credential); setReplacementValue(''); }} className="min-h-10 rounded-lg bg-primary-600 px-3 text-[13px] font-semibold text-white hover:bg-primary-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">{t('agentCredentials.edit')}</button>}
                <button type="button" disabled={busyId !== null} onClick={() => void rename(credential)} className="tone-action tone-muted min-h-10 rounded-lg px-3 text-[13px]">{t('agentCredentials.rename')}</button>
                <button type="button" disabled={busyId !== null} onClick={() => void remove(credential)} className="tone-action tone-danger min-h-10 rounded-lg px-3 text-[13px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">{t('agentCredentials.delete')}</button></div></details>
              </div>
              <details className="mt-3 text-[12px] text-surface-400"><summary className="cursor-pointer">{t('agentCredentials.details')}</summary><p className="mt-2 break-all font-mono">{credential.default_env_name || credential.id}</p>
              <dl className="mt-4 grid gap-2 text-[13px] sm:grid-cols-2"><div><dt className="text-surface-500">{t('agentCredentials.provider')}</dt><dd className="mt-0.5 text-surface-200">{credential.provider}</dd></div><div><dt className="text-surface-500">{t('agentCredentials.lastUpdated')}</dt><dd className="mt-0.5 text-surface-200">{formatDate(credential.rotated_at || credential.updated_at)}</dd></div></dl></details>
              {editing?.id === credential.id && <div className="mt-4 rounded-lg border border-primary-500/40 bg-surface-850 p-3"><label className="block text-[13px] font-semibold text-surface-200">{t('agentCredentials.newValue')}<textarea value={replacementValue} onChange={event => setReplacementValue(event.target.value)} rows={4} autoComplete="off" data-1p-ignore className="mt-2 w-full resize-y rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-[14px] text-surface-100 outline-none focus-visible:ring-2 focus-visible:ring-primary-400" /></label><div className="mt-3 flex gap-2"><button type="button" disabled={!replacementValue || busyId !== null} onClick={() => void rotate()} className="min-h-10 rounded-lg bg-primary-600 px-3 text-[13px] font-semibold text-white disabled:bg-surface-800 disabled:text-surface-500">{t('agentCredentials.replace')}</button><button type="button" onClick={() => { setEditing(null); setReplacementValue(''); }} className="min-h-10 rounded-lg border border-surface-700 px-3 text-[13px] font-semibold text-surface-300">{t('agentCredentials.cancel')}</button></div></div>}
            </article>)}</div>
          </section>
          <section className="border-t border-surface-800 p-5 sm:p-7"><AgentConnectionsPanel projectId={project.id} hideAgentConnections view="shared" /></section>
          {adding && <section ref={addRef} tabIndex={-1} className="border-t border-surface-800 p-5 sm:p-7" aria-label={t('agentCredentials.addConnection')}>
            <h3 className="text-lg font-semibold text-surface-100">{t('agentCredentials.addConnection')}</h3>
            <div className="my-4 flex flex-wrap gap-2">{(['google', 'api', 'import'] as const).map(method => <button key={method} type="button" aria-pressed={addMethod === method} onClick={() => { setAddMethod(method); setSecretValue(''); }} className={`tone-action min-h-10 rounded-lg px-3 text-[13px] ${addMethod === method ? 'tone-accent' : 'tone-muted'}`}>{t(`agentCredentials.method_${method}`)}</button>)}</div>
            <p className="mb-4 text-[12px] text-surface-400">{t('agentCredentials.chatInjectionNotice')}</p>
            {addMethod !== 'api' && <AgentConnectionsPanel projectId={project.id} spacious hideAgentConnections view={addMethod} />}
            {addMethod === 'api' &&             <section className="border-b border-surface-800 p-5 sm:p-7"><h3 className="text-lg font-semibold text-surface-100">{t('agentCredentials.addTitle')}</h3><p className="mb-5 mt-1 text-[14px] leading-6 text-surface-400">{t('agentCredentials.addDescription')}</p><div className="space-y-4 py-4">
              <label className="block text-[14px] font-medium text-surface-300">{t('agentCredentials.provider')}<input value={provider} onChange={event => setProvider(event.target.value)} placeholder={t('agentCredentials.providerPlaceholder')} className="mt-2 min-h-11 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 text-[14px] text-surface-100 outline-none placeholder:text-surface-600 focus:border-primary-400 focus-visible:ring-2 focus-visible:ring-primary-400/40" /></label>
              <label className="block text-[14px] font-medium text-surface-300">{t('agentCredentials.displayName')}<input value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder={t('agentCredentials.displayNamePlaceholder')} className="mt-2 min-h-11 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 text-[14px] text-surface-100 outline-none placeholder:text-surface-600 focus:border-primary-400 focus-visible:ring-2 focus-visible:ring-primary-400/40" /></label>
              <label className="block text-[14px] font-medium text-surface-300">{t('agentCredentials.envName')}<input value={envName} onChange={event => setEnvName(event.target.value)} placeholder={t('agentCredentials.envNamePlaceholder')} className="mt-2 min-h-11 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 font-mono text-[14px] text-surface-100 outline-none placeholder:text-surface-600 focus:border-primary-400 focus-visible:ring-2 focus-visible:ring-primary-400/40" /></label>
              <label className="block text-[14px] font-medium text-surface-300">{t('agentCredentials.value')}<textarea value={secretValue} onChange={event => setSecretValue(event.target.value)} placeholder={t('agentCredentials.valuePlaceholder')} rows={4} autoComplete="off" data-1p-ignore className="mt-2 w-full resize-y rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-[14px] text-surface-100 outline-none placeholder:text-surface-600 focus:border-primary-400 focus-visible:ring-2 focus-visible:ring-primary-400/40" /></label>
              <div className="rounded-lg bg-surface-850 p-3 text-[12px] leading-5 text-surface-400">{t('agentCredentials.securityNotice')}</div>
              <button type="button" disabled={!ready || saving} onClick={() => void save()} className="min-h-11 w-full rounded-lg bg-primary-600 px-4 text-[14px] font-semibold text-white hover:bg-primary-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:cursor-not-allowed disabled:bg-surface-800 disabled:text-surface-500">{saving ? t('agentCredentials.saving') : t('agentCredentials.addAction')}</button>
            </div></section>}
          </section>}
        </div>
      </section>
    </div>
  );
}
