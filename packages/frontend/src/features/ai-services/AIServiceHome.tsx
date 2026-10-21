import React from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import type { Project } from '@tower/shared';
import { AgentIdentityAvatar } from '../agent-profile/AgentIdentityAvatar';
import { useConfirm } from '../../hooks/useDialog';
import { getCurrentRole } from '../../utils/auth';
import { useAIServiceStore, type AIServiceChannelAccessMode, type AIServiceChannelUsageSummary, type AIServiceConversationSummary, type AIServicePublicUiConfig, type AIServiceSummary } from './ai-services-store';

const FILTER_IDS = ['all', 'active', 'draft', 'review', 'paused'] as const;

function filterLabel(id: typeof FILTER_IDS[number]) {
  return i18n.t(`aiServices.home.filters.${id}`);
}

const QUICK_WEB_HARNESS = {
  id: 'quick-web-research',
  version: 1,
  profileId: 'web-only',
  profileVersion: 1,
  engine: 'Pi',
  model: 'Smart',
  capabilities: [
    { id: 'web.search', tool: 'WebSearch', label: i18n.t('aiServices.publicChat.tools.WebSearch'), detail: i18n.t('aiServices.home.ui.capabilityKnowledgeDetail') },
    { id: 'web.fetch', tool: 'WebFetch', label: i18n.t('aiServices.publicChat.tools.WebFetch'), detail: i18n.t('aiServices.home.copy.supportedCapabilities') },
  ],
} as const;

type CreateMode = 'published' | 'custom-draft';
type ChannelSummary = NonNullable<AIServiceSummary['channels']>[number];
type EffectiveHarness = {
  id: string;
  version: number;
  runtimeProfileId: string;
  runtimeProfileVersion: number;
  engine: 'pi' | 'claude';
  defaultModel: string | null;
  capabilityIds: string[];
};
type PublishedHarness = {
  id: string;
  name: string;
  description?: string;
  current_version: number;
  engine?: 'pi' | 'claude';
  runtime_profile_id?: string;
  runtime_profile_version?: number;
  effective_manifest?: Partial<EffectiveHarness> & { runtimeProfile?: { id?: string; version?: number } };
};

type KnowledgePickerEntry = { name: string; path: string; isDirectory: boolean; size?: number; children?: KnowledgePickerEntry[] };
const KNOWLEDGE_EXTENSIONS = new Set(['.md', '.txt']);
const KNOWLEDGE_PROMPT_TOKEN_LIMIT = 40_000;

function knowledgeExtension(name: string): string { const dot = name.lastIndexOf('.'); return dot >= 0 ? name.slice(dot).toLowerCase() : ''; }
function relativeKnowledgePath(rootPath: string, filePath: string): string { return filePath.slice(rootPath.replace(/\/$/, '').length).replace(/^\/+/, ''); }

function KnowledgeFilePicker({ project, selected, onApply, onClose }: { project: { rootPath?: string; name: string }; selected: string[]; onApply: (paths: string[]) => void; onClose: () => void }) {
  const rootPath = project.rootPath || '';
  const [currentPath, setCurrentPath] = React.useState(rootPath);
  const [entries, setEntries] = React.useState<KnowledgePickerEntry[]>([]);
  const [chosen, setChosen] = React.useState<Set<string>>(new Set(selected));
  const [sizes, setSizes] = React.useState<Record<string, number>>({});
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const loadDirectory = React.useCallback(async (nextPath: string) => {
    if (!nextPath) return;
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/files/tree?path=${encodeURIComponent(nextPath)}`, { headers: authJsonHeaders() });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || i18n.t('aiServices.home.knowledgeLoadFailed'));
      const rows = Array.isArray(body.entries) ? body.entries as KnowledgePickerEntry[] : [];
      setEntries(rows.filter((item) => item.isDirectory || KNOWLEDGE_EXTENSIONS.has(knowledgeExtension(item.name))).sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'ko')));
      setCurrentPath(nextPath);
    } catch (cause) { setEntries([]); setError(cause instanceof Error ? cause.message : i18n.t('aiServices.home.knowledgeLoadFailed')); }
    finally { setLoading(false); }
  }, []);
  React.useEffect(() => { void loadDirectory(rootPath); }, [loadDirectory, rootPath]);
  const toggle = (entry: KnowledgePickerEntry) => {
    const relative = relativeKnowledgePath(rootPath, entry.path);
    setChosen((current) => { const next = new Set(current); if (next.has(relative)) next.delete(relative); else next.add(relative); return next; });
    setSizes((current) => ({ ...current, [relative]: Number(entry.size || 0) }));
  };
  const selectedBytes = [...chosen].reduce((sum, value) => sum + Number(sizes[value] || 0), 0);
  const estimatedTokens = Math.ceil(selectedBytes / 3);
  const overLimit = estimatedTokens > KNOWLEDGE_PROMPT_TOKEN_LIMIT;
  const parentPath = currentPath !== rootPath ? currentPath.slice(0, currentPath.lastIndexOf('/')) : null;
  return <div className="fixed inset-0 z-[140] grid place-items-center bg-black/70 p-4" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-label={i18n.t('aiServices.home.pickerLabel')} className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-surface-700 dark:bg-surface-900" onClick={(event) => event.stopPropagation()}>
      <header className="border-b border-slate-200 px-5 py-4 dark:border-surface-800"><div className="text-sm font-bold text-slate-950 dark:text-surface-100">{i18n.t('aiServices.home.pickerLabel')}</div><p className="mt-1 text-xs text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.pickerDescription', { name: project.name })}</p></header>
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-surface-800"><button type="button" disabled={!parentPath} onClick={() => parentPath && void loadDirectory(parentPath)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs disabled:opacity-35 dark:border-surface-700">{i18n.t('aiServices.home.parent')}</button><code className="min-w-0 truncate text-xs text-slate-500 dark:text-surface-500">{relativeKnowledgePath(rootPath, currentPath) || '/'}</code></div>
      <div className="min-h-64 flex-1 overflow-y-auto p-3">{loading ? <div className="p-8 text-center text-sm text-slate-500">{i18n.t('aiServices.home.loading')}</div> : error ? <div className="p-8 text-center text-sm text-red-600">{error}</div> : entries.length === 0 ? <div className="p-8 text-center text-sm text-slate-500">{i18n.t('aiServices.home.noMaterials')}</div> : entries.map((entry) => entry.isDirectory ? <button key={entry.path} type="button" onClick={() => void loadDirectory(entry.path)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-slate-100 dark:hover:bg-surface-800"><span>📁</span><span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span><span className="text-xs text-slate-400">{i18n.t('aiServices.home.open')}</span></button> : <label key={entry.path} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-slate-100 dark:hover:bg-surface-800"><input type="checkbox" checked={chosen.has(relativeKnowledgePath(rootPath, entry.path))} onChange={() => toggle(entry)} /><span>📄</span><span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span><span className="text-xs text-slate-400">{Number(entry.size || 0).toLocaleString()} B</span></label>)}</div>
      <footer className="border-t border-slate-200 px-5 py-4 dark:border-surface-800"><div className={`mb-3 text-xs ${overLimit ? 'text-red-700 dark:text-red-300' : 'text-slate-500 dark:text-surface-500'}`}>{i18n.t('aiServices.home.ui.knowledgeSelectionSummary', { count: chosen.size, bytes: selectedBytes.toLocaleString(), tokens: estimatedTokens.toLocaleString() })} {overLimit ? `· ${i18n.t('aiServices.home.ui.knowledgeLimitExceeded', { limit: KNOWLEDGE_PROMPT_TOKEN_LIMIT.toLocaleString() })}` : ''}</div><div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-surface-700">{i18n.t('aiServices.home.cancel')}</button><button type="button" disabled={overLimit} onClick={() => onApply([...chosen].sort())} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-bold text-white disabled:bg-slate-300 dark:disabled:bg-surface-700">{i18n.t('aiServices.home.ui.selectMaterialCount', { count: chosen.size })}</button></div></footer>
    </section>
  </div>;
}

const CAPABILITY_COPY: Record<string, { tool: string; label: string; detail: string }> = {
  'web.search': { tool: 'WebSearch', label: i18n.t('aiServices.publicChat.tools.WebSearch'), detail: i18n.t('aiServices.home.ui.capabilityKnowledgeDetail') },
  'web.fetch': { tool: 'WebFetch', label: i18n.t('aiServices.publicChat.tools.WebFetch'), detail: i18n.t('aiServices.home.copy.supportedCapabilities') },
};

function effectiveHarness(item: PublishedHarness): EffectiveHarness {
  if (item.id === QUICK_WEB_HARNESS.id) return {
    id: item.id, version: item.current_version, runtimeProfileId: QUICK_WEB_HARNESS.profileId,
    runtimeProfileVersion: QUICK_WEB_HARNESS.profileVersion, engine: 'pi',
    defaultModel: 'litellm-responses/smart', capabilityIds: QUICK_WEB_HARNESS.capabilities.map((capability) => capability.id),
  };
  const manifest = item.effective_manifest || {};
  const runtimeProfileId = String(manifest.runtimeProfileId || manifest.runtimeProfile?.id || item.runtime_profile_id || '');
  const runtimeProfileVersion = Number(manifest.runtimeProfileVersion || manifest.runtimeProfile?.version || item.runtime_profile_version || 1);
  return {
    id: item.id, version: Number(manifest.version || item.current_version),
    runtimeProfileId,
    runtimeProfileVersion, engine: item.engine === 'claude' ? 'claude' : 'pi',
    defaultModel: typeof manifest.defaultModel === 'string' ? manifest.defaultModel : null,
    capabilityIds: Array.isArray(manifest.capabilityIds) ? manifest.capabilityIds : [],
  };
}

function harnessSlug(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function tone(status: string) {
  if (status === 'active') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200';
  if (status === 'review') return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200';
  if (status === 'paused') return 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-200';
  return 'border-surface-700 bg-surface-800/60 text-surface-500 dark:text-surface-300';
}

function label(status: string) {
  if (status === 'active' || status === 'review' || status === 'paused' || status === 'draft') {
    return i18n.t(`aiServices.status.${status}`);
  }
  return status;
}

function accessModeLabel(mode: AIServiceChannelAccessMode): string {
  return i18n.t(`aiServices.home.accessMode.${mode}`);
}

function channelAccessMode(channel?: ChannelSummary): AIServiceChannelAccessMode {
  const mode = channel?.accessMode;
  return mode === 'public' || mode === 'password' || mode === 'login_required' || mode === 'disabled' ? mode : 'unlisted';
}

function channelPublicUi(channel?: ChannelSummary): Required<AIServicePublicUiConfig> {
  return {
    showInfoPanel: channel?.publicUi?.showInfoPanel !== false,
    showTools: channel?.publicUi?.showTools !== false,
    showMaterials: channel?.publicUi?.showMaterials !== false,
    showTiming: channel?.publicUi?.showTiming !== false,
  };
}

function isExternallyAccessible(service: AIServiceSummary, channel?: ChannelSummary) {
  return service.status === 'active' && channel?.status === 'enabled' && channelAccessMode(channel) !== 'disabled';
}

function isAccessStopped(service: AIServiceSummary, channel?: ChannelSummary) {
  return service.status === 'paused' || channelAccessMode(channel) === 'disabled';
}

function operationalFilter(service: AIServiceSummary): 'active' | 'draft' | 'review' | 'paused' {
  const channel = service.channels?.find((item) => item.status === 'enabled') || service.channels?.[0];
  if (isAccessStopped(service, channel)) return 'paused';
  if (isExternallyAccessible(service, channel)) return 'active';
  if (service.status === 'review') return 'review';
  return 'draft';
}

function deploymentKnowledgeRefs(service: AIServiceSummary) {
  return service.currentDeployment?.sourceSnapshot?.refs?.filter((ref) => typeof ref.path === 'string' && ref.path) || [];
}

function shortDate(value?: string | null) {
  if (!value) return i18n.t('aiServices.home.notDeployedYet');
  const date = new Date(value);
  const locale = i18n.resolvedLanguage === 'ko' ? 'ko-KR' : 'en-US';
  return Number.isNaN(date.getTime()) ? i18n.t('aiServices.home.dateUnavailable') : new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function exposureLabel(service: AIServiceSummary, channel?: ChannelSummary) {
  const mode = channelAccessMode(channel);
  if (mode === 'disabled' || mode === 'password' || mode === 'login_required') {
    return i18n.t(`aiServices.exposure.${mode === 'login_required' ? 'loginRequired' : mode}`);
  }
  if (service.status === 'active' && channel?.status === 'enabled') {
    return i18n.t(`aiServices.exposure.${mode === 'public' ? 'publicActive' : 'linkActive'}`);
  }
  if (service.status === 'active' || service.status === 'review' || service.status === 'paused') {
    return i18n.t(`aiServices.exposure.${service.status}`);
  }
  return i18n.t('aiServices.exposure.notPublished');
}

type ChannelCredentialResponse = {
  token: string;
  expiresAt: string;
  serving?: { conversationUrl?: string; messageUrlTemplate?: string; chatUrlTemplate?: string; authorization?: string; exposure?: string; robots?: string };
};

function authJsonHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function copyText(value: string) {
  if (!value) return;
  await navigator.clipboard?.writeText(value).catch(() => undefined);
}

function previewAnswerText(value: unknown): string {
  const body = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (typeof body.text === 'string') return body.text;
  if (typeof body.answer === 'string') return body.answer;
  const message = body.message && typeof body.message === 'object' ? body.message as Record<string, unknown> : {};
  return typeof message.text === 'string' ? message.text : '';
}

function makeSharePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(10);
  window.crypto?.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => alphabet[byte % alphabet.length]).join('');
}

type RequestActionDraft = { enabled: boolean; label: string; description: string; confirmationLabel: string; subjectPrefix: string; recipientEmail: string; collectName: boolean; collectEmail: boolean; collectPhone: boolean };

function emptyRequestAction(): RequestActionDraft {
  return { enabled: false, label: i18n.t('aiServices.home.requestAction.label'), description: i18n.t('aiServices.home.requestAction.description'), confirmationLabel: i18n.t('aiServices.home.requestAction.confirmation'), subjectPrefix: i18n.t('aiServices.home.requestAction.subjectPrefix'), recipientEmail: '', collectName: true, collectEmail: true, collectPhone: false };
}

function requestActionDraft(experienceSnapshot?: Record<string, unknown>): RequestActionDraft {
  const raw = Array.isArray(experienceSnapshot?.requestActions) && experienceSnapshot.requestActions[0] && typeof experienceSnapshot.requestActions[0] === 'object' ? experienceSnapshot.requestActions[0] as Record<string, unknown> : null;
  const defaults = emptyRequestAction();
  if (!raw) return defaults;
  const destination = raw.destination && typeof raw.destination === 'object' ? raw.destination as Record<string, unknown> : {};
  const fields = Array.isArray(raw.fields) ? raw.fields : [];
  return { enabled: true, label: String(raw.label || defaults.label), description: String(raw.description || ''), confirmationLabel: String(raw.confirmationLabel || defaults.confirmationLabel), subjectPrefix: String(raw.subjectPrefix || defaults.subjectPrefix), recipientEmail: String(destination.to || ''), collectName: fields.includes('name'), collectEmail: fields.includes('email'), collectPhone: fields.includes('phone') };
}

function requestActionsSnapshot(draft: RequestActionDraft): Array<Record<string, unknown>> {
  if (!draft.enabled) return [];
  return [{ id: 'contact-company', label: draft.label.trim(), description: draft.description.trim(), confirmationLabel: draft.confirmationLabel.trim(), subjectPrefix: draft.subjectPrefix.trim(), fields: [draft.collectName && 'name', draft.collectEmail && 'email', draft.collectPhone && 'phone'].filter(Boolean), destination: { type: 'email', to: draft.recipientEmail.trim() } }];
}

function DeploymentVersionPanel({ service }: { service: AIServiceSummary }) {
  const createDeployment = useAIServiceStore((s) => s.createDeployment);
  const deployNow = useAIServiceStore((s) => s.deployNow);
  const rollbackDeployment = useAIServiceStore((s) => s.rollbackDeployment);
  const mutating = useAIServiceStore((s) => s.mutatingId === service.id);
  const current = service.currentDeployment;
  const currentPaths = deploymentKnowledgeRefs(service).map((ref) => ref.path!).filter(Boolean);
  const [open, setOpen] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [nextPaths, setNextPaths] = React.useState<string[]>(currentPaths);
  const [requestAction, setRequestAction] = React.useState<RequestActionDraft>(() => requestActionDraft(current?.experienceSnapshot));
  const [refreshIdentity, setRefreshIdentity] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  React.useEffect(() => { setNextPaths(currentPaths); setRequestAction(requestActionDraft(current?.experienceSnapshot)); setRefreshIdentity(false); }, [service.id, current?.id]);
  if (!current) return null;
  const previous = service.deployments?.find((item) => item.status === 'superseded');
  const added = nextPaths.filter((path) => !currentPaths.includes(path));
  const removed = currentPaths.filter((path) => !nextPaths.includes(path));
  const unchanged = nextPaths.filter((path) => currentPaths.includes(path));
  const editablePaths = [...new Set([...currentPaths, ...nextPaths])].sort((a, b) => a.localeCompare(b));
  const currentRequestAction = requestActionDraft(current.experienceSnapshot);
  const requestActionChanged = JSON.stringify(requestAction) !== JSON.stringify(currentRequestAction);
  const identity = current.experienceSnapshot?.identity && typeof current.experienceSnapshot.identity === 'object' ? current.experienceSnapshot.identity as Record<string, unknown> : {};
  const deployedProfileVersion = Number(identity.sourceAgentProfileVersion || 0);
  const currentProfileVersion = Number(service.ownerAgentProfileVersion || 0);
  const profileUpdateAvailable = currentProfileVersion > deployedProfileVersion;
  const changed = added.length > 0 || removed.length > 0 || requestActionChanged || refreshIdentity;
  const requestActionValid = !requestAction.enabled || Boolean(requestAction.label.trim() && requestAction.confirmationLabel.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requestAction.recipientEmail.trim()));
  const createNext = async () => {
    if (!changed || !requestActionValid) return;
    setBusy(true); setError('');
    try {
      const next = await createDeployment(service.id, {
        sourceSnapshot: nextPaths.length ? { kind: 'knowledge', version: 1, refs: nextPaths.map((path) => ({ path })) } : { kind: 'none', version: 1, refs: [], userFacingLabel: i18n.t('aiServices.home.noDeploymentMaterials') },
        policySnapshot: current.policySnapshot || {},
        experienceSnapshot: { ...(current.experienceSnapshot || { greeting: i18n.t('aiServices.home.greetingKnowledge') }), requestActions: requestActionsSnapshot(requestAction) },
        evaluationSnapshot: { status: 'not_run', cases: [] },
        refreshIdentityFromSourceAgent: refreshIdentity,
      });
      await deployNow(service.id, next.id);
      setOpen(false);
    } catch (err) { setError(err instanceof Error ? err.message : i18n.t('aiServices.home.ui.deployFailed')); }
    finally { setBusy(false); }
  };
  const rollback = async () => {
    if (!previous) return;
    setBusy(true); setError('');
    try { await rollbackDeployment(service.id, previous.id); }
    catch (err) { setError(err instanceof Error ? err.message : i18n.t('aiServices.home.ui.deployFailed')); }
    finally { setBusy(false); }
  };
  return <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 dark:border-surface-800 dark:bg-surface-950/45" aria-label={i18n.t('aiServices.home.ui.deploymentVersion')}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-sm font-bold text-slate-900 dark:text-surface-100">{i18n.t('aiServices.home.ui.deploymentVersion')}</div><p className="mt-1 text-xs leading-5 text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.ui.deploymentVersionDescription')}</p></div><div className="flex gap-2"><button type="button" onClick={() => setOpen((value) => !value)} className="rounded-lg border border-teal-300 bg-teal-50 px-3 py-2 text-xs font-bold text-teal-800 hover:bg-teal-100 dark:border-primary-500/35 dark:bg-primary-500/10 dark:text-primary-200">{open ? i18n.t('aiServices.home.ui.closePreparation') : i18n.t('aiServices.home.ui.prepareNewVersion')}</button>{previous && <button type="button" disabled={busy || mutating} onClick={() => void rollback()} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-surface-700 dark:bg-transparent dark:text-surface-300">{i18n.t('aiServices.home.ui.rollbackVersion', { version: previous.version })}</button>}</div></div>
    <div className="mt-3 flex flex-wrap gap-2 text-[11px]"><span className="rounded-full bg-emerald-50 px-2 py-1 font-bold text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">{i18n.t('aiServices.home.ui.currentVersionBadge', { version: current.version })}</span>{(service.deployments || []).slice(0, 4).map((item) => <span key={item.id} className="rounded-full border border-slate-200 px-2 py-1 text-slate-500 dark:border-surface-700 dark:text-surface-500">v{item.version} · {item.status === 'active' ? i18n.t('aiServices.home.ui.running') : item.status === 'superseded' ? i18n.t('aiServices.home.ui.previousVersion') : item.status}</span>)}</div>
    {open && <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-surface-800 dark:bg-surface-900/45"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-xs font-bold text-slate-800 dark:text-surface-200">{i18n.t('aiServices.home.ui.knowledgeConfig', { version: current.version + 1 })}</div><p className="mt-1 text-[11px] text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.ui.knowledgeSnapshotDescription')}</p></div><button type="button" disabled={!service.ownerProjectRootPath} onClick={() => setPickerOpen(true)} className="rounded-lg border border-teal-300 bg-white px-3 py-2 text-xs font-bold text-teal-800 disabled:opacity-50 dark:border-primary-500/35 dark:bg-transparent dark:text-primary-200">{i18n.t('aiServices.home.ui.addFromFinder')}</button></div>
      <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-surface-700 dark:bg-surface-950/50"><div className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2 dark:border-surface-800"><span className="text-[11px] font-bold text-slate-700 dark:text-surface-300">{i18n.t('aiServices.home.ui.newVersionMaterials')}</span><button type="button" disabled={nextPaths.length === 0} onClick={() => setNextPaths([])} className="text-[11px] font-semibold text-red-700 disabled:opacity-35 dark:text-red-300">{i18n.t('aiServices.home.ui.clearAll')}</button></div>{editablePaths.length === 0 ? <div className="px-3 py-4 text-xs text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.ui.noConnectedMaterials')}</div> : <ul className="max-h-48 overflow-y-auto">{editablePaths.map((path) => { const included = nextPaths.includes(path); const isNew = !currentPaths.includes(path); return <li key={path} className="border-b border-slate-100 last:border-b-0 dark:border-surface-800/70"><label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-slate-50 dark:hover:bg-surface-900"><input type="checkbox" checked={included} onChange={(event) => setNextPaths((paths) => event.target.checked ? [...new Set([...paths, path])].sort() : paths.filter((item) => item !== path))} /><span className={`min-w-0 flex-1 truncate font-mono text-[11px] ${included ? 'text-slate-700 dark:text-surface-300' : 'text-slate-400 line-through dark:text-surface-600'}`}>{path}</span><span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${!included ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300' : isNew ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-surface-800 dark:text-surface-400'}`}>{!included ? i18n.t('aiServices.home.ui.removed') : isNew ? i18n.t('aiServices.home.ui.added') : i18n.t('aiServices.home.ui.unchanged')}</span></label></li>; })}</ul>}</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3"><div className="rounded-lg border border-emerald-200 bg-white p-3 dark:border-emerald-500/20 dark:bg-surface-950/50"><div className="text-[11px] font-bold text-emerald-800 dark:text-emerald-200">{i18n.t('aiServices.home.ui.added')} {added.length}</div>{added.slice(0, 3).map((path) => <div key={path} className="mt-1 truncate font-mono text-[10px] text-emerald-700 dark:text-emerald-300">+ {path}</div>)}</div><div className="rounded-lg border border-red-200 bg-white p-3 dark:border-red-500/20 dark:bg-surface-950/50"><div className="text-[11px] font-bold text-red-700 dark:text-red-200">{i18n.t('aiServices.home.ui.removed')} {removed.length}</div>{removed.slice(0, 3).map((path) => <div key={path} className="mt-1 truncate font-mono text-[10px] text-red-600 dark:text-red-300">− {path}</div>)}</div><div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-surface-700 dark:bg-surface-950/50"><div className="text-[11px] font-bold text-slate-700 dark:text-surface-300">{i18n.t('aiServices.home.ui.unchanged')} {unchanged.length}</div><div className="mt-1 text-[10px] text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.ui.samePath')}</div></div></div>
      <section className={`mt-4 rounded-lg border p-3 ${profileUpdateAvailable ? 'border-amber-300 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/8' : 'border-slate-200 bg-white dark:border-surface-700 dark:bg-surface-950/50'}`} aria-label="에이전트 프로필 버전"><div className="flex flex-wrap items-center justify-between gap-3"><div><div className="text-xs font-bold text-slate-800 dark:text-surface-200">에이전트 상담 지침</div><p className="mt-1 text-[11px] text-slate-500 dark:text-surface-500">현재 배포 v{deployedProfileVersion} · 베이스 팀원 v{currentProfileVersion}</p></div>{profileUpdateAvailable ? <label className="flex cursor-pointer items-center gap-2 text-xs font-bold text-amber-900 dark:text-amber-100"><input type="checkbox" checked={refreshIdentity} onChange={(event) => setRefreshIdentity(event.target.checked)} />최신 상담 지침을 새 버전에 반영</label> : <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-300">최신 상태</span>}</div>{profileUpdateAvailable && <p className="mt-2 text-[11px] leading-5 text-amber-800/80 dark:text-amber-200/80">기존 외부 배포는 유지됩니다. 체크하면 베이스 팀원의 현재 role·promise·instruction을 새 버전에 다시 고정합니다.</p>}</section>
      <section className="mt-4 border-t border-slate-200 pt-4 dark:border-surface-700" aria-label={i18n.t('aiServices.home.ui.customerRequestButton')}><label className="flex items-center justify-between gap-3"><span><span className="block text-xs font-bold text-slate-800 dark:text-surface-200">{i18n.t('aiServices.home.ui.customerRequestButton')}</span><span className="mt-1 block text-[11px] text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.ui.customerRequestDescription')}</span></span><input type="checkbox" checked={requestAction.enabled} onChange={(event) => setRequestAction((current) => ({ ...current, enabled: event.target.checked }))} /></label>{requestAction.enabled && <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-[11px] font-semibold text-slate-600 dark:text-surface-400">{i18n.t('aiServices.home.ui.buttonLabel')}<input value={requestAction.label} onChange={(event) => setRequestAction((current) => ({ ...current, label: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100" /></label><label className="text-[11px] font-semibold text-slate-600 dark:text-surface-400">{i18n.t('aiServices.home.ui.recipientEmail')}<input type="email" value={requestAction.recipientEmail} onChange={(event) => setRequestAction((current) => ({ ...current, recipientEmail: event.target.value }))} placeholder="support@example.com" className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100" /></label><label className="text-[11px] font-semibold text-slate-600 dark:text-surface-400 sm:col-span-2">{i18n.t('aiServices.home.ui.description')}<input value={requestAction.description} onChange={(event) => setRequestAction((current) => ({ ...current, description: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100" /></label><label className="text-[11px] font-semibold text-slate-600 dark:text-surface-400">{i18n.t('aiServices.home.ui.confirmationLabel')}<input value={requestAction.confirmationLabel} onChange={(event) => setRequestAction((current) => ({ ...current, confirmationLabel: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100" /></label><label className="text-[11px] font-semibold text-slate-600 dark:text-surface-400">{i18n.t('aiServices.home.ui.subjectPrefix')}<input value={requestAction.subjectPrefix} onChange={(event) => setRequestAction((current) => ({ ...current, subjectPrefix: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100" /></label><div className="flex flex-wrap gap-4 text-xs text-slate-600 dark:text-surface-400 sm:col-span-2"><label><input type="checkbox" checked={requestAction.collectName} onChange={(event) => setRequestAction((current) => ({ ...current, collectName: event.target.checked }))} /> {i18n.t('aiServices.home.ui.collectName')}</label><label><input type="checkbox" checked={requestAction.collectEmail} onChange={(event) => setRequestAction((current) => ({ ...current, collectEmail: event.target.checked }))} /> {i18n.t('aiServices.home.ui.collectEmail')}</label><label><input type="checkbox" checked={requestAction.collectPhone} onChange={(event) => setRequestAction((current) => ({ ...current, collectPhone: event.target.checked }))} /> {i18n.t('aiServices.home.ui.collectPhone')}</label></div>{!requestActionValid && <div className="text-[11px] text-red-700 dark:text-red-300 sm:col-span-2">{i18n.t('aiServices.home.ui.requestActionInvalid')}</div>}<p className="text-[11px] leading-5 text-slate-500 dark:text-surface-500 sm:col-span-2">{i18n.t('aiServices.home.ui.requestActionPrivacy')}</p></div>}</section>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-[11px] leading-5 text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.ui.newVersionImpact', { current: current.version, next: current.version + 1 })}</p><button type="button" disabled={!changed || !requestActionValid || busy || mutating} onClick={() => void createNext()} className="rounded-lg border border-teal-300 bg-teal-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-teal-500 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:border-primary-400/35 dark:bg-primary-500/15 dark:text-primary-100">{busy ? i18n.t('aiServices.home.ui.activatingVersion') : i18n.t('aiServices.home.ui.createActivateVersion', { version: current.version + 1 })}</button></div>{!changed && <div className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">{i18n.t('aiServices.home.ui.noVersionChanges')}</div>}{error && <div className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</div>}</div>}
    {pickerOpen && service.ownerProjectRootPath && <KnowledgeFilePicker project={{ rootPath: service.ownerProjectRootPath, name: service.ownerAgentName || service.name }} selected={nextPaths} onApply={(paths) => { setNextPaths(paths); setPickerOpen(false); }} onClose={() => setPickerOpen(false)} />}
  </section>;
}

function DeploymentFlowPanel({ service, channel }: { service: AIServiceSummary; channel?: ChannelSummary }) {
  const deployNow = useAIServiceStore((s) => s.deployNow);
  const mutating = useAIServiceStore((s) => s.mutatingId === service.id);
  const [error, setError] = React.useState('');
  const deployment = service.latestDeployment || service.latest_deployment || service.currentDeployment || null;
  const publish = async () => {
    if (!deployment?.id) return;
    setError('');
    try { await deployNow(service.id, deployment.id); }
    catch (err) { setError(err instanceof Error ? err.message : i18n.t('aiServices.home.ui.deployFailed')); }
  };
  if (isExternallyAccessible(service, channel)) return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-white/80 p-3 text-xs text-emerald-800 dark:border-emerald-500/25 dark:bg-surface-950/35 dark:text-emerald-200">
      <span><span className="font-bold">{i18n.t('aiServices.home.ui.deploymentLiveTitle')} · </span>{i18n.t('aiServices.home.ui.deploymentLiveDescription')}</span>
      <span className="rounded-full bg-emerald-100 px-2 py-1 font-bold text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200">{i18n.t('aiServices.home.ui.healthy')}</span>
    </div>
  );
  if (service.status === 'active' && channel?.status === 'enabled' && channelAccessMode(channel) === 'disabled') return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/8 dark:text-amber-200">
      <span><span className="font-bold">{i18n.t('aiServices.home.ui.deploymentPausedTitle')} · </span>{i18n.t('aiServices.home.ui.deploymentPausedDescription')}</span>
      <span className="rounded-full bg-amber-100 px-2 py-1 font-bold text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">{i18n.t('aiServices.home.ui.accessBlocked')}</span>
    </div>
  );
  return (
    <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-500/25 dark:bg-emerald-500/8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><div className="text-sm font-bold text-emerald-900 dark:text-emerald-100">{service.status === 'paused' ? i18n.t('aiServices.home.ui.deploymentPausedNotice') : i18n.t('aiServices.home.ui.notDeployedNotice')}</div><p className="mt-1 text-xs text-emerald-700/80 dark:text-emerald-200/75">{i18n.t('aiServices.home.ui.oneClickDeployDescription')}</p></div>
        <button type="button" disabled={!deployment?.id || mutating} onClick={() => void publish()} className="rounded-xl border border-emerald-500/35 bg-emerald-600 px-5 py-3 text-sm font-black text-white shadow-sm hover:bg-emerald-500 disabled:border-emerald-200 disabled:bg-emerald-100 disabled:text-emerald-500 disabled:shadow-none dark:disabled:border-emerald-900 dark:disabled:bg-emerald-950 dark:disabled:text-emerald-700">{mutating ? i18n.t('aiServices.home.ui.deploying') : service.status === 'paused' ? i18n.t('aiServices.home.ui.resumeOperation') : i18n.t('aiServices.home.ui.externalDeployment')}</button>
      </div>
      {error && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-200">{error}</div>}
    </div>
  );
}

function quotaTone(status?: string) {
  if (status === 'exceeded') return 'text-red-700 dark:text-red-300';
  if (status === 'near') return 'text-amber-700 dark:text-amber-300';
  return 'text-emerald-700 dark:text-emerald-300';
}

function ChannelUsagePanel({ service, channel }: { service: AIServiceSummary; channel?: ChannelSummary }) {
  const getChannelUsage = useAIServiceStore((s) => s.getChannelUsage);
  const updateChannelQuota = useAIServiceStore((s) => s.updateChannelQuota);
  const [open, setOpen] = React.useState(false);
  const [usage, setUsage] = React.useState<AIServiceChannelUsageSummary | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const [quotaDraft, setQuotaDraft] = React.useState({ windowSeconds: 60, channelLimit: 120, tenantLimit: 30, tenantDailyLimit: 1000, tokenLimit: 1_000_000 });
  const syncDraft = (next: AIServiceChannelUsageSummary) => setQuotaDraft({ windowSeconds: next.windowSeconds, channelLimit: next.channelLimit, tenantLimit: next.tenantLimit, tenantDailyLimit: next.tenantDailyLimit, tokenLimit: next.tokenLimit });
  const load = async () => {
    if (!channel) return;
    setLoading(true); setError('');
    try { const next = await getChannelUsage(service.id, channel.id); setUsage(next); syncDraft(next); }
    catch (err) { setError(err instanceof Error ? err.message : i18n.t('aiServices.home.ui.usageLoadFailed')); }
    finally { setLoading(false); }
  };
  const saveQuota = async () => {
    if (!channel) return;
    setSaving(true); setError('');
    try { const next = await updateChannelQuota(service.id, channel.id, quotaDraft); setUsage(next); syncDraft(next); }
    catch (err) { setError(err instanceof Error ? err.message : i18n.t('aiServices.home.ui.quotaSaveFailed')); }
    finally { setSaving(false); }
  };
  const setQuotaField = (key: keyof typeof quotaDraft, value: string) => setQuotaDraft((current) => ({ ...current, [key]: Math.max(1, Math.floor(Number(value) || 1)) }));
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-surface-800 dark:bg-surface-950/45">
      <button type="button" onClick={() => { setOpen((value) => !value); if (!open && !usage) void load(); }} className="flex w-full items-center justify-between gap-3 text-left">
        <span><span className="text-xs font-bold text-slate-900 dark:text-surface-200">{i18n.t('aiServices.home.ui.usageLogs')}</span><span className="ml-2 text-[11px] text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.usageDescription')}</span></span>
        <span className="text-xs font-semibold text-teal-700 dark:text-primary-300">{open ? i18n.t('aiServices.home.ui.close') : i18n.t('aiServices.home.open')}</span>
      </button>
      {open && <div className="mt-3 grid gap-3 md:grid-cols-5">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-900/45"><div className="text-[11px] text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.recentMessages')}</div><div className={`mt-1 text-lg font-bold ${quotaTone(usage?.quota.status)}`}>{usage?.channelMessageTurns ?? '—'} / {usage?.channelLimit ?? '—'}</div><div className="mt-1 text-[10px] text-slate-400 dark:text-surface-600">{i18n.t('aiServices.home.ui.windowSeconds', { count: usage?.windowSeconds ?? '—' })}</div></div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-900/45"><div className="text-[11px] text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.visitorLimit')}</div><div className="mt-1 text-lg font-bold text-slate-900 dark:text-surface-200">{i18n.t('aiServices.home.ui.times', { count: usage?.tenantLimit ?? '—' })}</div><div className="mt-1 text-[10px] text-slate-400 dark:text-surface-600">{i18n.t('aiServices.home.ui.dailyTimes', { count: usage?.tenantDailyLimit ?? '—' })}</div></div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-900/45"><div className="text-[11px] text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.conversationCount')}</div><div className="mt-1 text-lg font-bold text-slate-900 dark:text-surface-200">{usage?.conversationsCreated ?? '—'}</div><div className="mt-1 text-[10px] text-slate-400 dark:text-surface-600">{i18n.t('aiServices.home.ui.dailyMessages', { count: usage?.channelDailyMessageTurns ?? '—' })}</div></div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-900/45"><div className="text-[11px] text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.remainingRequests')}</div><div className="mt-1 text-lg font-bold text-slate-900 dark:text-surface-200">{usage?.quota.channelRemaining ?? '—'}</div><div className="mt-1 text-[10px] text-slate-400 dark:text-surface-600">{i18n.t('aiServices.home.ui.externalConnections', { count: usage?.credentialIssued ?? '—' })}</div></div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-900/45"><div className="text-[11px] text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.tokenUsage')}</div><div className="mt-1 text-lg font-bold text-slate-900 dark:text-surface-200">{(usage?.totalTokens ?? 0).toLocaleString()}</div><div className="mt-1 text-[10px] text-slate-400 dark:text-surface-600">{i18n.t('aiServices.home.ui.limitValue', { count: (usage?.tokenLimit ?? 0).toLocaleString() })}</div></div>
        <details className="md:col-span-4 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-900/45">
          <summary className="cursor-pointer text-[11px] font-bold text-slate-700 dark:text-surface-300">{i18n.t('aiServices.home.ui.advancedQuota')}</summary>
          <div className="mt-3 grid gap-2 md:grid-cols-5">
          <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">{i18n.t('aiServices.home.ui.aggregationSeconds')}<input type="number" min={1} value={quotaDraft.windowSeconds} onChange={(event) => setQuotaField('windowSeconds', event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" /></label>
          <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">{i18n.t('aiServices.home.ui.totalRequestLimit')}<input type="number" min={1} value={quotaDraft.channelLimit} onChange={(event) => setQuotaField('channelLimit', event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" /></label>
          <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">{i18n.t('aiServices.home.ui.visitorRequestLimit')}<input type="number" min={1} value={quotaDraft.tenantLimit} onChange={(event) => setQuotaField('tenantLimit', event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" /></label>
          <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">{i18n.t('aiServices.home.ui.visitorDailyLimit')}<input type="number" min={1} value={quotaDraft.tenantDailyLimit} onChange={(event) => setQuotaField('tenantDailyLimit', event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" /></label>
          <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">{i18n.t('aiServices.home.ui.totalTokenLimit')}<input type="number" min={1} value={quotaDraft.tokenLimit} onChange={(event) => setQuotaField('tokenLimit', event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" /></label>
          <div className="md:col-span-5 flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-surface-500">
            <button type="button" disabled={!channel || loading} onClick={() => void load()} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 dark:border-surface-700 dark:bg-transparent dark:text-surface-300 dark:hover:bg-surface-800/50 dark:disabled:bg-surface-900 dark:disabled:text-surface-600">{loading ? i18n.t('aiServices.home.ui.refreshing') : i18n.t('aiServices.home.ui.refresh')}</button>
            <button type="button" disabled={!channel || saving} onClick={() => void saveQuota()} className="rounded-lg border border-teal-300 bg-teal-600 px-3 py-2 text-xs font-bold text-white hover:bg-teal-500 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:border-primary-400/35 dark:bg-primary-500/15 dark:text-primary-100 dark:hover:bg-primary-500/25 dark:disabled:border-surface-800 dark:disabled:bg-surface-900 dark:disabled:text-surface-600">{saving ? i18n.t('aiServices.home.ui.saving') : i18n.t('aiServices.home.ui.saveQuota')}</button>
            {usage && <span>{i18n.t('aiServices.home.ui.visitorSummary', { count: usage.uniqueTenants, top: usage.topTenant ? `${usage.topTenant.tenantKey} (${i18n.t('aiServices.home.ui.times', { count: usage.topTenant.messageTurns })})` : i18n.t('aiServices.home.none') })}</span>}
            {!channel && <span className="text-amber-700 dark:text-amber-300">{i18n.t('aiServices.home.ui.usageAvailableAfterDeploy')}</span>}
            {error && <span className="text-red-300">{error}</span>}
          </div>
          </div>
        </details>
      </div>}
    </div>
  );
}

function ChannelCredentialPanel({ service, channel }: { service: AIServiceSummary; channel?: ChannelSummary }) {
  const updateChannelAccess = useAIServiceStore((s) => s.updateChannelAccess);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [tenantKey, setTenantKey] = React.useState('default');
  const [userKey, setUserKey] = React.useState('visitor');
  const [exposure, setExposure] = React.useState<'auth-required' | 'unlisted' | 'public'>('unlisted');
  const [credential, setCredential] = React.useState<ChannelCredentialResponse | null>(null);
  const [status, setStatus] = React.useState<'idle'|'issuing'|'revoking'|'saving-access'>('idle');
  const [error, setError] = React.useState('');
  const [accessMode, setAccessMode] = React.useState<AIServiceChannelAccessMode>(() => channelAccessMode(channel));
  const [accessUi, setAccessUi] = React.useState<Required<AIServicePublicUiConfig>>(() => channelPublicUi(channel));
  const [accessPassword, setAccessPassword] = React.useState('');
  const [passwordCopied, setPasswordCopied] = React.useState(false);
  const [linkCopied, setLinkCopied] = React.useState(false);
  const [testQuestion, setTestQuestion] = React.useState(i18n.t('aiServices.home.testQuestionDefault'));
  const [testStatus, setTestStatus] = React.useState<'idle'|'running'>('idle');
  const [testAnswer, setTestAnswer] = React.useState('');
  const [testError, setTestError] = React.useState('');
  React.useEffect(() => { setAccessMode(channelAccessMode(channel)); setAccessUi(channelPublicUi(channel)); setAccessPassword(''); }, [channel?.id, channel?.accessMode, channel?.publicUi]);
  const canIssue = service.status === 'active' && channel?.status === 'enabled' && accessMode !== 'disabled';
  const createPassword = async () => { const next = makeSharePassword(); setAccessMode('password'); setAccessPassword(next); setPasswordCopied(false); await copyText(next); setPasswordCopied(true); };
  const publicWebsiteUrl = channel ? `${window.location.origin}/ai/${encodeURIComponent(channel.id)}` : '';
  const hostedChatUrl = credential?.serving?.chatUrlTemplate?.replace('<token>', encodeURIComponent(credential.token)) || publicWebsiteUrl;
  const copyPublicLink = async () => { await copyText(publicWebsiteUrl); setLinkCopied(true); window.setTimeout(() => setLinkCopied(false), 1800); };
  const sharePublicLink = async () => {
    if (!publicWebsiteUrl) return;
    if (navigator.share) {
      try { await navigator.share({ title: service.name, text: i18n.t('aiServices.home.ui.shareText', { name: service.name }), url: publicWebsiteUrl }); return; }
      catch (err) { if (err instanceof DOMException && err.name === 'AbortError') return; }
    }
    await copyPublicLink();
  };
  const testCurrentDeployment = async () => {
    if (!channel || !testQuestion.trim() || !canIssue) return;
    setTestStatus('running'); setTestAnswer(''); setTestError('');
    try {
      const created = await fetch(`/api/ai-services/${encodeURIComponent(service.id)}/preview/conversations`, { method: 'POST', headers: authJsonHeaders(), body: JSON.stringify({ channelId: channel.id }) });
      const conversation = await created.json().catch(() => ({}));
      if (!created.ok || !conversation.id) throw new Error(conversation.error || i18n.t('aiServices.home.testConversationHttp', { status: created.status }));
      const response = await fetch(`/api/ai-services/${encodeURIComponent(service.id)}/preview/conversations/${encodeURIComponent(conversation.id)}/messages`, { method: 'POST', headers: authJsonHeaders(), body: JSON.stringify({ channelId: channel.id, message: testQuestion.trim() }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || i18n.t('aiServices.home.testQuestionHttp', { status: response.status }));
      const answer = previewAnswerText(body);
      if (!answer.trim()) throw new Error(i18n.t('aiServices.home.emptyTestAnswer'));
      setTestAnswer(answer);
    } catch (err) { setTestError(err instanceof Error ? err.message : i18n.t('aiServices.home.testFailed')); }
    finally { setTestStatus('idle'); }
  };
  const issue = async () => {
    if (!channel || !tenantKey.trim() || !userKey.trim()) return;
    setStatus('issuing'); setError('');
    try {
      const res = await fetch(`/api/ai-services/${encodeURIComponent(service.id)}/channels/${encodeURIComponent(channel.id)}/credentials`, { method: 'POST', headers: authJsonHeaders(), body: JSON.stringify({ tenantKey: tenantKey.trim(), userKey: userKey.trim(), exposure, ttlSeconds: 3600 }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setCredential(body);
    } catch (err) { setError(err instanceof Error ? err.message : i18n.t('aiServices.home.linkCreateFailed')); }
    finally { setStatus('idle'); }
  };
  const saveAccess = async () => {
    if (!channel) return;
    setStatus('saving-access'); setError('');
    try {
      await updateChannelAccess(service.id, channel.id, { mode: accessMode, password: accessMode === 'password' ? accessPassword : undefined, ui: accessUi });
      setAccessPassword('');
    } catch (err) { setError(err instanceof Error ? err.message : i18n.t('aiServices.home.accessSaveFailed')); }
    finally { setStatus('idle'); }
  };
  const revoke = async () => {
    if (!channel || !credential?.token) return;
    setStatus('revoking'); setError('');
    try {
      const res = await fetch(`/api/ai-services/${encodeURIComponent(service.id)}/channels/${encodeURIComponent(channel.id)}/credentials/revoke`, { method: 'POST', headers: authJsonHeaders(), body: JSON.stringify({ token: credential.token, reason: 'ui-revoke' }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setCredential(null);
    } catch (err) { setError(err instanceof Error ? err.message : i18n.t('aiServices.home.linkRevokeFailed')); }
    finally { setStatus('idle'); }
  };
  return (
    <div className="@container/access min-w-0 [word-break:keep-all] [overflow-wrap:anywhere] mt-4 rounded-2xl border border-emerald-200 bg-white p-4 shadow-sm dark:border-emerald-500/20 dark:bg-surface-950/35">
      <div className="flex flex-col gap-3 @min-[48rem]/access:flex-row @min-[48rem]/access:items-start @min-[48rem]/access:justify-between">
        <div>
          <div className="text-sm font-bold text-slate-950 dark:text-surface-100">{i18n.t('aiServices.home.copy.externalLink')}</div>
          <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-surface-500">{i18n.t('aiServices.home.copy.externalLinkDescription')}</p>
        </div>
        <div className="flex flex-wrap gap-2 [&>button]:shrink-0 [&>button]:whitespace-nowrap">
          <button type="button" disabled={!canIssue} onClick={() => void sharePublicLink()} className="rounded-xl border border-emerald-300 bg-emerald-600 px-4 py-3 text-sm font-bold text-white shadow-sm hover:bg-emerald-500 disabled:border-emerald-200 disabled:bg-emerald-100 disabled:text-emerald-500 disabled:shadow-none dark:border-emerald-400/35 dark:bg-emerald-500/15 dark:text-emerald-100 dark:hover:bg-emerald-500/25 dark:disabled:border-emerald-900 dark:disabled:bg-emerald-950 dark:disabled:text-emerald-700">{i18n.t('aiServices.home.ui.share')}</button>
          <button type="button" disabled={!canIssue} onClick={() => void copyPublicLink()} className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:border-surface-700 dark:bg-transparent dark:text-surface-200 dark:hover:bg-surface-800/50 dark:disabled:border-surface-800 dark:disabled:bg-surface-900 dark:disabled:text-surface-600">{linkCopied ? i18n.t('aiServices.home.ui.copied') : i18n.t('aiServices.home.ui.copyLink')}</button>
          <button type="button" disabled={!canIssue} onClick={() => window.open(publicWebsiteUrl, '_blank', 'noopener,noreferrer')} className="col-span-2 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:border-surface-700 dark:bg-transparent dark:text-surface-200 dark:hover:bg-surface-800/50 dark:disabled:border-surface-800 dark:disabled:bg-surface-900 dark:disabled:text-surface-600 sm:col-span-1">{i18n.t('aiServices.home.ui.openAgent')}</button>
          {credential && <button type="button" disabled={status !== 'idle'} onClick={() => void revoke()} className="rounded-xl border border-red-200 bg-white px-3 py-2.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-40 dark:border-red-500/25 dark:bg-transparent dark:text-red-200">{i18n.t('aiServices.home.ui.revokeAdvancedLink')}</button>}
        </div>
      </div>
      <div className="mt-4 grid gap-3 rounded-xl border border-emerald-200 bg-white/80 p-3 dark:border-surface-800 dark:bg-surface-950/60 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] items-end [&>label]:min-w-0">
        <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">{i18n.t('aiServices.home.ui.accessMethod')}<select value={accessMode} onChange={(event) => setAccessMode(event.target.value as AIServiceChannelAccessMode)} disabled={!channel || status !== 'idle'} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs font-semibold text-slate-900 outline-none focus:border-teal-500 disabled:bg-slate-100 disabled:text-slate-400 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500 dark:disabled:bg-surface-900 dark:disabled:text-surface-600">{accessMode === 'login_required' && <option value="login_required" disabled>{accessModeLabel('login_required')}</option>}{(['unlisted', 'password', 'disabled', 'public'] as const).map((mode) => <option key={mode} value={mode}>{accessModeLabel(mode)}</option>)}</select></label>
        <label className={`text-[11px] font-semibold ${accessMode === 'password' ? 'text-slate-700 dark:text-surface-400' : 'text-slate-400 dark:text-surface-700'}`}>{i18n.t('aiServices.home.ui.sharePassword')}<input value={accessPassword} onChange={(event) => { setAccessPassword(event.target.value); setPasswordCopied(false); }} disabled={!channel || accessMode !== 'password' || status !== 'idle'} type="text" placeholder={channel?.hasPassword ? i18n.t('aiServices.home.ui.keepPassword') : i18n.t('aiServices.home.ui.passwordOrGenerate')} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none placeholder:text-slate-400 focus:border-teal-500 disabled:bg-slate-100 disabled:text-slate-400 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:placeholder:text-surface-600 dark:focus:border-primary-500 dark:disabled:bg-surface-900 dark:disabled:text-surface-600" /></label>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!channel || status !== 'idle'} onClick={() => void createPassword()} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 dark:border-surface-700 dark:bg-transparent dark:text-surface-300 dark:hover:bg-surface-800/50 dark:disabled:bg-surface-900 dark:disabled:text-surface-600">{passwordCopied ? i18n.t('aiServices.home.ui.passwordCreated') : i18n.t('aiServices.home.ui.createPassword')}</button>
          <button type="button" disabled={!channel || status !== 'idle' || accessMode === 'login_required' || (accessMode === 'password' && !channel?.hasPassword && !accessPassword.trim())} onClick={() => void saveAccess()} className="rounded-lg border border-teal-300 bg-teal-600 px-3 py-2 text-xs font-bold text-white hover:bg-teal-500 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:border-primary-400/35 dark:bg-primary-500/15 dark:text-primary-100 dark:hover:bg-primary-500/25 dark:disabled:border-surface-800 dark:disabled:bg-surface-900 dark:disabled:text-surface-600">{status === 'saving-access' ? i18n.t('aiServices.home.ui.saving') : i18n.t('aiServices.home.ui.save')}</button>
        </div>
        <div className="col-span-full grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2 dark:border-surface-800 dark:bg-surface-900/35 grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))]">
          {[
            ['showInfoPanel', i18n.t('aiServices.home.ui.showInfoPanel')], ['showTools', i18n.t('aiServices.home.ui.showTools')], ['showMaterials', i18n.t('aiServices.home.ui.showMaterials')], ['showTiming', i18n.t('aiServices.home.ui.showTiming')],
          ].map(([key, label]) => <label key={key} className="flex items-center gap-2 text-[11px] font-semibold text-slate-700 dark:text-surface-400"><input type="checkbox" checked={Boolean(accessUi[key as keyof typeof accessUi])} onChange={(event) => setAccessUi((current) => ({ ...current, [key]: event.target.checked }))} disabled={!channel || status !== 'idle'} className="h-3.5 w-3.5 shrink-0 rounded border-slate-300 accent-teal-600 disabled:opacity-45 dark:border-surface-700 dark:bg-surface-950 dark:accent-primary-500" />{label}</label>)}
        </div>
        <p className="col-span-full text-[11px] leading-5 text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.copy.passwordGuidance')}</p>
      </div>
      {!canIssue && <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">{i18n.t('aiServices.home.copy.notPublishedHint')}</div>}
      {error && <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-200">{error}</div>}
      {canIssue && <section className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-900/35" aria-label={i18n.t('aiServices.home.copy.currentAnswerCheck')}><div className="text-xs font-bold text-slate-800 dark:text-surface-200">{i18n.t('aiServices.home.copy.currentAnswerCheck')}</div><p className="mt-1 text-[11px] leading-5 text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.copy.currentAnswerCheckDescription')}</p><div className="mt-3 flex flex-col gap-2 @min-[32rem]/access:flex-row"><input value={testQuestion} onChange={(event) => setTestQuestion(event.target.value)} disabled={testStatus === 'running'} className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100" aria-label={i18n.t('aiServices.home.ui.testQuestion')} /><button type="button" disabled={!testQuestion.trim() || testStatus === 'running'} onClick={() => void testCurrentDeployment()} className="rounded-lg border border-teal-300 bg-white px-4 py-2.5 text-sm font-bold text-teal-800 disabled:opacity-50 dark:border-primary-500/35 dark:bg-transparent dark:text-primary-200">{testStatus === 'running' ? i18n.t('aiServices.home.ui.checkingAnswer') : i18n.t('aiServices.home.ui.sendTest')}</button></div>{testAnswer && <div className="mt-3 rounded-lg border border-emerald-200 bg-white p-3 text-sm leading-6 text-slate-800 dark:border-emerald-500/20 dark:bg-surface-950 dark:text-surface-200"><div className="mb-1 text-[11px] font-bold text-emerald-700 dark:text-emerald-300">{i18n.t('aiServices.home.ui.validAnswer')}</div>{testAnswer}</div>}{testError && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-200"><div className="mb-1 text-[11px] font-bold">{i18n.t('aiServices.home.copy.testFailure')}</div>{testError}</div>}</section>}
      {canIssue ? <div className="mt-4 rounded-xl border border-emerald-200 bg-white p-3 shadow-sm dark:border-surface-800 dark:bg-surface-950/70">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-bold text-emerald-700 dark:text-emerald-200">{i18n.t('aiServices.home.ui.shareLink')}</span><span className="text-[11px] text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.copy.publishedAuto')}</span></div>
        <button type="button" onClick={() => void copyPublicLink()} className="mt-2 block w-full break-all rounded-lg bg-emerald-50 px-3 py-3 text-left text-xs text-emerald-800 dark:bg-surface-900 dark:text-emerald-200" aria-label={i18n.t('aiServices.home.copy.copyShareLink')}>{publicWebsiteUrl}</button>
        <div className="mt-3 flex flex-wrap gap-2 [&>button]:shrink-0 [&>button]:whitespace-nowrap">
          <button type="button" onClick={() => void sharePublicLink()} className="rounded-lg border border-primary-300 bg-primary-50 px-3 py-3 text-sm font-bold text-primary-800 dark:border-primary-400/35 dark:bg-transparent dark:text-primary-200">{i18n.t('aiServices.home.ui.share')}</button>
          <button type="button" onClick={() => void copyPublicLink()} className="rounded-lg border border-slate-200 px-3 py-3 text-sm font-bold text-slate-700 dark:border-surface-700 dark:text-surface-300">{linkCopied ? i18n.t('aiServices.home.ui.copied') : i18n.t('aiServices.home.ui.copyLink')}</button>
          <button type="button" onClick={() => window.open(publicWebsiteUrl, '_blank', 'noopener,noreferrer')} className="col-span-2 rounded-lg border border-slate-200 px-3 py-3 text-sm font-semibold text-slate-700 dark:border-surface-700 dark:text-surface-300 sm:col-span-1">{i18n.t('aiServices.home.ui.openAgent')}</button>
        </div>
      </div> : <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white/70 p-4 text-sm text-slate-500 dark:border-surface-700 dark:bg-surface-950/35 dark:text-surface-500">{i18n.t('aiServices.home.copy.noPublishedAgent')}</div>}
      <button type="button" onClick={() => setAdvancedOpen((value) => !value)} className="mt-3 text-xs font-semibold text-slate-500 hover:text-slate-800 dark:text-surface-500 dark:hover:text-surface-300">{advancedOpen ? i18n.t('aiServices.home.ui.closeAdvanced') : i18n.t('aiServices.home.ui.openAdvanced')}</button>
      {advancedOpen && <div className="mt-3 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-950/45 @min-[40rem]/access:grid-cols-3">
        <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">Tenant key<input value={tenantKey} onChange={(event) => setTenantKey(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" /></label>
        <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">User key<input value={userKey} onChange={(event) => setUserKey(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" /></label>
        <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">Exposure<select value={exposure} onChange={(event) => setExposure(event.target.value as typeof exposure)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500"><option value="auth-required">auth-required</option><option value="unlisted">unlisted</option><option value="public">public</option></select></label>
        <div className="col-span-full flex flex-wrap items-center gap-2">
          <button type="button" disabled={!canIssue || status !== 'idle'} onClick={() => void issue()} className="rounded-lg border border-teal-300 bg-white px-3 py-2 text-xs font-semibold text-teal-800 hover:bg-teal-50 disabled:bg-slate-100 disabled:text-slate-400 dark:border-primary-400/35 dark:bg-transparent dark:text-primary-200 dark:disabled:opacity-40">{status === 'issuing' ? i18n.t('aiServices.home.ui.issuingAdvanced') : i18n.t('aiServices.home.ui.issueAdvanced')}</button>
        </div>
        {credential && <div className="col-span-full grid gap-2 text-[11px]">
          <div className="grid gap-1"><span className="text-slate-500 dark:text-surface-600">Credential Chat URL</span><code className="break-all rounded bg-white px-2 py-1 text-emerald-800 ring-1 ring-slate-200 dark:bg-surface-900 dark:text-emerald-200 dark:ring-0">{hostedChatUrl}</code></div>
          <div className="grid gap-1"><span className="text-slate-500 dark:text-surface-600">Session API URL</span><code className="break-all rounded bg-white px-2 py-1 text-teal-800 ring-1 ring-slate-200 dark:bg-surface-900 dark:text-primary-200 dark:ring-0">{credential.serving?.conversationUrl}</code><button type="button" onClick={() => void copyText(credential.serving?.conversationUrl || '')} className="justify-self-start text-teal-700 dark:text-primary-300">{i18n.t('aiServices.home.ui.copyApi')}</button></div>
          <div className="grid gap-1"><span className="text-slate-500 dark:text-surface-600">Message API URL template</span><code className="break-all rounded bg-white px-2 py-1 text-teal-800 ring-1 ring-slate-200 dark:bg-surface-900 dark:text-primary-200 dark:ring-0">{credential.serving?.messageUrlTemplate}</code></div>
          <div className="grid gap-1"><span className="text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.copy.tokenWarning')}</span><textarea readOnly value={credential.token} className="min-h-20 rounded border border-slate-200 bg-white p-2 font-mono text-[10px] text-slate-700 dark:border-surface-800 dark:bg-surface-900 dark:text-surface-300" /><button type="button" onClick={() => void copyText(credential.token)} className="justify-self-start text-teal-700 dark:text-primary-300">{i18n.t('aiServices.home.ui.copyToken')}</button></div>
        </div>}
      </div>}
    </div>
  );
}

function ConversationHistoryPanel({ service }: { service: AIServiceSummary }) {
  const getConversations = useAIServiceStore((s) => s.getConversations);
  const [conversations, setConversations] = React.useState<AIServiceConversationSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    void getConversations(service.id).then((items) => { if (live) setConversations(items); }).catch((err) => { if (live) setError(err instanceof Error ? err.message : i18n.t('aiServices.home.historyLoadFailed')); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [getConversations, service.id, service.metrics?.conversations]);
  return <section className="border-t border-slate-200 py-5 dark:border-surface-800" aria-labelledby={`conversation-history-${service.id}`}>
    <div className="flex items-end justify-between gap-3"><div><h4 id={`conversation-history-${service.id}`} className="text-sm font-bold text-slate-900 dark:text-surface-100">{i18n.t('aiServices.home.ui.pastConversations')}</h4><p className="mt-1 text-xs text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.copy.historyDescription')}</p></div><span className="text-xs font-semibold text-slate-500 dark:text-surface-500">{conversations.length}</span></div>
    {loading ? <div className="py-6 text-sm text-slate-500">{i18n.t('aiServices.home.ui.loadingConversations')}</div> : error ? <div className="py-6 text-sm text-red-600 dark:text-red-300">{error}</div> : conversations.length === 0 ? <div className="py-6 text-sm text-slate-500">{i18n.t('aiServices.home.ui.noConversations')}</div> : <div className="mt-3 divide-y divide-slate-200 border-y border-slate-200 dark:divide-surface-800 dark:border-surface-800">
      {conversations.map((conversation) => <div key={conversation.id} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
        <div className="min-w-0"><div className="truncate text-sm font-semibold text-slate-800 dark:text-surface-200">{conversation.sessionName || i18n.t('aiServices.home.ui.conversationFallback', { id: conversation.id.slice(0, 8) })}</div><div className="mt-1 text-[11px] text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.conversationMeta', { date: new Date(conversation.updatedAt).toLocaleString(i18n.resolvedLanguage || i18n.language), count: conversation.messageCount })}</div></div>
        <div className="text-xs text-slate-600 dark:text-surface-400">{Number(conversation.totalTokens || 0).toLocaleString()} tokens</div>
        {conversation.runtimeSessionId ? <button type="button" onClick={() => { window.location.href = `/s/${encodeURIComponent(conversation.runtimeSessionId!)}`; }} className="justify-self-start text-xs font-bold text-teal-700 hover:text-teal-600 dark:text-primary-300">{i18n.t('aiServices.home.ui.openSession')}</button> : <span className="text-xs text-slate-400">{i18n.t('aiServices.home.ui.sessionPreparing')}</span>}
      </div>)}
    </div>}
  </section>;
}

function baseAgentProject(service: AIServiceSummary): Project {
  const displayName = service.ownerAgentName || i18n.t('aiServices.home.unknownOwner');
  // Older/partial overview payloads may omit ownerProjectId. Avatar fallback
  // hashing requires a string, so keep rendering with the stable service id.
  const projectId = typeof service.ownerProjectId === 'string' && service.ownerProjectId ? service.ownerProjectId : service.id;
  return {
    id: projectId,
    name: displayName,
    description: null,
    rootPath: null,
    color: '#64748b',
    sortOrder: 0,
    collapsed: 0,
    archived: 0,
    createdAt: '',
    spaceId: null,
    agent: {
      id: `project:${projectId}`,
      kind: 'primary',
      projectId,
      displayName,
      face: service.ownerAgentFace || '✨',
      tagline: null,
      role: null,
      promise: null,
      profileVersion: 0,
      instructionSource: 'ai-service-overview',
      defaultEngine: null,
      defaultModel: null,
      authorityPolicy: {},
      toolPolicy: {},
      memoryPolicy: {},
      budgetPolicy: {},
      status: 'active',
      onboardingState: 'ready',
      explicit: true,
    },
  };
}

function ServiceListItem({ service, selected, onSelect }: { service: AIServiceSummary; selected: boolean; onSelect: () => void }) {
  const channel = service.channels?.find((item) => item.status === 'enabled') || service.channels?.[0];
  const baseProject = baseAgentProject(service);
  const operationalState = operationalFilter(service);
  return <button type="button" onClick={onSelect} aria-pressed={selected} className={`w-full border-b border-slate-200 px-4 py-4 text-left transition-colors last:border-b-0 dark:border-surface-800 ${selected ? 'bg-teal-50 dark:bg-primary-500/10' : 'hover:bg-slate-50 dark:hover:bg-surface-800/45'}`}>
    <div className="flex items-start gap-3">
      <AgentIdentityAvatar project={baseProject} variant="list" showListAccent={false} className="h-10 w-10 shrink-0 rounded-xl" />
      <div className="min-w-0 flex-1"><div className="truncate text-sm font-bold text-slate-950 dark:text-surface-100">{service.name}</div><div className="mt-1 truncate text-xs text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.ui.baseLabel', { name: service.ownerAgentName || i18n.t('aiServices.home.primaryAiTeammate') })}</div></div>
      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${operationalState === 'active' ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-200' : operationalState === 'paused' ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200' : tone(service.status)}`}>{operationalState === 'active' ? i18n.t('aiServices.home.ui.running') : operationalState === 'paused' ? i18n.t('aiServices.home.ui.accessStopped') : label(service.status)}</span>
    </div>
    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 pl-[52px] text-[11px] text-slate-500 dark:text-surface-600"><span>v{service.currentDeployment?.version || 0}</span><span>{i18n.t('aiServices.home.ui.conversationMetric', { count: service.metrics?.conversations || 0 })}</span><span>{channelAccessMode(channel) === 'disabled' ? i18n.t('aiServices.home.ui.accessStopped') : channelAccessMode(channel) === 'password' ? i18n.t('aiServices.home.ui.passwordProtected') : channelAccessMode(channel) === 'public' ? i18n.t('aiServices.home.ui.fullyPublic') : i18n.t('aiServices.home.ui.linkShared')}</span></div>
  </button>;
}

function ServiceRow({ service, canManage }: { service: AIServiceSummary; canManage: boolean }) {
  const confirm = useConfirm();
  const retire = useAIServiceStore((s) => s.retire);
  const updateService = useAIServiceStore((s) => s.updateService);
  const updateChannelAccess = useAIServiceStore((s) => s.updateChannelAccess);
  const mutating = useAIServiceStore((s) => s.mutatingId === service.id);
  const [editOpen, setEditOpen] = React.useState(false);
  const [editName, setEditName] = React.useState(service.name);
  const [editDescription, setEditDescription] = React.useState(service.description || '');
  React.useEffect(() => { setEditName(service.name); setEditDescription(service.description || ''); }, [service.name, service.description]);
  const channel = service.channels?.find((item) => item.status === 'enabled') || service.channels?.[0];
  const knowledgeRefs = deploymentKnowledgeRefs(service);
  const operationalState = operationalFilter(service);
  const saveEdit = async () => { if (!editName.trim()) return; await updateService(service.id, { name: editName.trim(), description: editDescription }); setEditOpen(false); };
  const makePrivate = async () => {
    if (!channel) return;
    const ok = await confirm({ title: i18n.t('aiServices.home.ui.stopExternalAccess'), message: i18n.t('aiServices.home.ui.stopExternalAccessMessage'), confirmLabel: i18n.t('aiServices.home.ui.stopExternalAccess') });
    if (!ok) return;
    await updateChannelAccess(service.id, channel.id, { mode: 'disabled' });
  };
  const resumeExternalAccess = async () => {
    if (!channel) return;
    await updateChannelAccess(service.id, channel.id, { mode: 'unlisted' });
  };
  const deleteService = async () => {
    const ok = await confirm({ title: i18n.t('aiServices.home.ui.deleteExternalAgent'), message: i18n.t('aiServices.home.ui.deleteExternalAgentMessage'), confirmLabel: i18n.t('aiServices.home.ui.delete'), danger: true });
    if (!ok) return;
    await retire(service.id);
  };
  return (
    <article className="@container/service grid min-w-0 grid-cols-1 gap-4 border-t border-slate-200 px-4 py-5 first:border-t-0 dark:border-surface-800 sm:px-5" lang={i18n.resolvedLanguage || i18n.language}>
      <div className="min-w-0">
        <div className="flex items-start gap-3">
          <AgentIdentityAvatar project={baseAgentProject(service)} variant="list" showListAccent={false} className="h-12 w-12 shrink-0 rounded-xl" />
          <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-bold text-slate-950 dark:text-surface-100 [word-break:keep-all]">{service.name}</h3><span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${operationalState === 'active' ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-200' : operationalState === 'paused' ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200' : tone(service.status)}`}>{operationalState === 'active' ? i18n.t('aiServices.home.ui.running') : operationalState === 'paused' ? i18n.t('aiServices.home.ui.accessStopped') : label(service.status)}</span></div><p className="mt-1 text-xs font-semibold text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.ui.baseLabel', { name: service.ownerAgentName || i18n.t('aiServices.home.primaryAiTeammate') })}</p></div>
        </div>
        <p className="mt-3 line-clamp-2 text-sm leading-6 text-slate-600 dark:text-surface-500 [word-break:keep-all]">{service.description || i18n.t('aiServices.home.noDescription')}</p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-surface-600">
          <span>{i18n.t('aiServices.home.ui.currentDeploymentMeta', { version: service.currentDeployment ? `v${service.currentDeployment.version}` : i18n.t('aiServices.home.none') })}</span>
          <span>{i18n.t('aiServices.home.ui.deploymentDateMeta', { date: shortDate(service.currentDeployment?.deployedAt || service.currentDeployment?.createdAt) })}</span>
          <span>{i18n.t('aiServices.home.ui.externalAccessMeta', { status: operationalState === 'active' ? i18n.t('aiServices.home.available') : operationalState === 'paused' ? i18n.t('aiServices.home.stopped') : i18n.t('aiServices.home.preparing') })}</span>
          <span>{knowledgeRefs.length ? i18n.t('aiServices.home.ui.knowledgeMeta', { count: knowledgeRefs.length }) : i18n.t('aiServices.home.notConnected')}</span>
        </div>
        <div className="mt-4 grid gap-4 border-y border-slate-200 py-4 text-xs dark:border-surface-800 @min-[42rem]/service:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)] [&>div]:min-w-0 [overflow-wrap:anywhere]">
          <div><div className="text-[11px] font-semibold text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.executionConfig')}</div><div className="mt-1 font-semibold text-slate-800 dark:text-surface-200">{service.currentDeployment?.policySnapshot?.harnessBinding?.harnessId || i18n.t('aiServices.home.noHarness')}{service.currentDeployment?.policySnapshot?.harnessBinding?.harnessVersion ? ` @v${service.currentDeployment.policySnapshot.harnessBinding.harnessVersion}` : ''}</div><div className="mt-1 text-[11px] text-slate-500 dark:text-surface-600">{service.currentDeployment?.policySnapshot?.harnessBinding?.model || i18n.t('aiServices.home.harnessDefaultModel')}</div></div>
          <div><div className="text-[11px] font-semibold text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.currentVersion')}</div><div className="mt-1 font-semibold text-slate-800 dark:text-surface-200">{service.currentDeployment ? `${i18n.t('aiServices.home.published')} v${service.currentDeployment.version}` : i18n.t('aiServices.home.notYet')}</div><div className="mt-1 text-[11px] text-slate-500 dark:text-surface-600">{shortDate(service.currentDeployment?.deployedAt || service.currentDeployment?.createdAt)}</div></div>
          <div><div className="flex items-center justify-between gap-2"><div className="text-[11px] font-semibold text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.fixedKnowledge')}</div><span className="text-[10px] font-bold text-teal-700 dark:text-primary-300">{knowledgeRefs.length}</span></div>{knowledgeRefs.length ? <ul className="mt-1 space-y-1">{knowledgeRefs.slice(0, 3).map((ref) => <li key={ref.path} className="truncate font-mono text-[11px] text-slate-700 dark:text-surface-300">{ref.path}</li>)}</ul> : <div className="mt-1 text-[11px] text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.noPinnedKnowledge')}</div>}{knowledgeRefs.length > 3 && <div className="mt-1 text-[10px] text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.additionalCount', { count: knowledgeRefs.length - 3 })}</div>}</div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 font-semibold text-slate-600 dark:border-surface-700 dark:bg-surface-950/70 dark:text-surface-300">{exposureLabel(service, channel)}</span>
          <span className="text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.managementOverview')}</span>
        </div>
      </div>
      <dl className="grid max-w-md grid-cols-3 gap-3 text-left">
        <div><dt className="text-[11px] text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.conversations')}</dt><dd className="mt-1 font-bold text-slate-900 dark:text-surface-200">{service.metrics?.conversations || 0}</dd></div>
        <div><dt className="text-[11px] text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.unresolved')}</dt><dd className="mt-1 font-bold text-amber-600 dark:text-amber-300">{service.metrics?.unresolved || 0}</dd></div>
        <div><dt className="text-[11px] text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.cost')}</dt><dd className="mt-1 font-bold text-slate-900 dark:text-surface-200">${(service.metrics?.cost || 0).toFixed(2)}</dd></div>
      </dl>
      {canManage && <div className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-950/35">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><div className="text-xs font-bold text-slate-800 dark:text-surface-200">{i18n.t('aiServices.home.ui.managementOptions')}</div><p className="mt-1 text-[11px] text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.copy.managementDescription')}</p></div>
          <div className="flex flex-wrap gap-2">
            <button disabled={mutating} onClick={() => setEditOpen((value) => !value)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 dark:border-surface-700 dark:bg-transparent dark:text-surface-300 dark:hover:bg-surface-800/50">{editOpen ? i18n.t('aiServices.home.ui.closeEdit') : i18n.t('aiServices.home.ui.edit')}</button>
            {channelAccessMode(channel) === 'disabled'
              ? <button disabled={mutating || !channel} onClick={() => void resumeExternalAccess()} className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-500/30 dark:bg-transparent dark:text-emerald-200">{i18n.t('aiServices.home.ui.resumeAccess')}</button>
              : <button disabled={mutating || !channel} onClick={() => void makePrivate()} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-500/30 dark:bg-transparent dark:text-amber-200">{i18n.t('aiServices.home.ui.accessStopped')}</button>}
            <button disabled={mutating} onClick={() => void deleteService()} className="rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-500/25 dark:bg-transparent dark:text-red-200">{i18n.t('aiServices.home.ui.deleteAgent')}</button>
          </div>
        </div>
        {editOpen && <div className="mt-3 grid gap-2 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] items-end [&>label]:min-w-0">
          <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">{i18n.t('aiServices.home.ui.name')}<input value={editName} onChange={(event) => setEditName(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" /></label>
          <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">{i18n.t('aiServices.home.ui.description')}<input value={editDescription} onChange={(event) => setEditDescription(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" /></label>
          <button disabled={mutating || !editName.trim()} onClick={() => void saveEdit()} className="rounded-lg border border-teal-300 bg-teal-600 px-3 py-2 text-xs font-bold text-white hover:bg-teal-500 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:border-primary-400/35 dark:bg-primary-500/15 dark:text-primary-100">{i18n.t('aiServices.home.ui.save')}</button>
        </div>}
      </div>}
      <section className="min-w-0 rounded-3xl border border-emerald-200 bg-emerald-50/70 p-4 dark:border-emerald-500/20 dark:bg-emerald-500/5" aria-label={i18n.t('aiServices.home.ui.externalDeployTest')}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-sm font-black text-emerald-950 dark:text-emerald-100">{i18n.t('aiServices.home.ui.externalDeployTest')}</div>
            <p className="mt-1 text-xs leading-5 text-emerald-800/75 dark:text-emerald-200/75">{i18n.t('aiServices.home.copy.deployTestDescription')}</p>
          </div>
          <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${isExternallyAccessible(service, channel) ? 'border-emerald-300 bg-white text-emerald-800 dark:border-emerald-500/25 dark:bg-surface-950/50 dark:text-emerald-200' : channelAccessMode(channel) === 'disabled' ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/8 dark:text-amber-200' : 'border-slate-300 bg-white text-slate-700 dark:border-surface-700 dark:bg-surface-950/50 dark:text-surface-300'}`}>{isExternallyAccessible(service, channel) ? i18n.t('aiServices.home.ui.running') : channelAccessMode(channel) === 'disabled' ? i18n.t('aiServices.home.ui.accessStopped') : service.status === 'paused' ? i18n.t('aiServices.home.ui.paused') : i18n.t('aiServices.home.ui.beforeDeployment')}</span>
        </div>
        {canManage ? <>
          <DeploymentFlowPanel service={service} channel={channel} />
          <DeploymentVersionPanel service={service} />
          {service.status === 'active' && <>
            <ChannelCredentialPanel service={service} channel={channel} />
            <ChannelUsagePanel service={service} channel={channel} />
          </>}
        </> : channel ? <div className="mt-4 rounded-xl border border-emerald-200 bg-white p-3 dark:border-surface-800 dark:bg-surface-950/70">
          <div className="text-xs font-bold text-emerald-700 dark:text-emerald-200">{i18n.t('aiServices.home.ui.shareLink')}</div>
          <a href={`/ai/${encodeURIComponent(channel.id)}`} target="_blank" rel="noreferrer" className="mt-2 block break-all text-xs text-emerald-800 underline-offset-2 hover:underline dark:text-emerald-200">{`${window.location.origin}/ai/${encodeURIComponent(channel.id)}`}</a>
        </div> : null}
      </section>
      <div className="min-w-0"><ConversationHistoryPanel service={service} /></div>
    </article>
  );
}

function HarnessChoice({ mode, harnesses, selectedId, onSelect, onOpenDraft }: { mode: CreateMode; harnesses: PublishedHarness[]; selectedId: string; onSelect: (id: string) => void; onOpenDraft: () => void }) {
  return (
    <div className="mt-5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-slate-900 dark:text-surface-200">{i18n.t('aiServices.home.ui.toolSystem')}</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-surface-500 [word-break:keep-all]">{i18n.t('aiServices.home.copy.toolSystemDescription')}</p>
        </div>
        <span className="rounded-md border border-slate-200 px-2 py-1 font-mono text-[10px] text-slate-500 dark:border-surface-700 dark:text-surface-500">Harness</span>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {harnesses.map((item) => { const effective = effectiveHarness(item); const selected = mode === 'published' && selectedId === item.id; return <button key={item.id} type="button" onClick={() => onSelect(item.id)} aria-pressed={selected} className={`rounded-xl border p-3 text-left transition-colors ${selected ? 'border-emerald-400 bg-emerald-50 dark:border-emerald-500/45 dark:bg-emerald-500/8' : 'border-slate-200 bg-white hover:border-slate-300 dark:border-surface-700 dark:bg-surface-950/55 dark:hover:border-surface-600'}`}>
          <div className="flex items-center justify-between gap-2"><span className="text-sm font-bold text-slate-900 dark:text-surface-100">{item.name}</span><span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">{i18n.t('aiServices.home.published')}</span></div>
          <p className="mt-1 font-mono text-[10px] text-slate-500 dark:text-surface-500">{item.id}@v{item.current_version} · {effective.runtimeProfileId}@v{effective.runtimeProfileVersion}</p>
          <p className="mt-3 text-xs leading-5 text-slate-600 dark:text-surface-400">Pi · {effective.defaultModel || i18n.t('aiServices.home.defaultModel')} · capability {effective.capabilityIds.length}</p>
        </button>; })}
        <button type="button" onClick={onOpenDraft} aria-pressed={mode === 'custom-draft'} className={`rounded-xl border p-3 text-left transition-colors ${mode === 'custom-draft' ? 'border-amber-400 bg-amber-50 dark:border-amber-500/45 dark:bg-amber-500/8' : 'border-slate-200 bg-white hover:border-slate-300 dark:border-surface-700 dark:bg-surface-950/55 dark:hover:border-surface-600'}`}>
          <div className="flex items-center justify-between gap-2"><span className="text-sm font-bold text-slate-900 dark:text-surface-100">{i18n.t('aiServices.home.ui.newToolSystem')}</span><span className="text-[10px] font-semibold text-amber-700 dark:text-amber-300">Harness draft</span></div>
          <p className="mt-1 text-[10px] text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.copy.draftServerDescription')}</p>
          <p className="mt-3 text-xs leading-5 text-slate-600 dark:text-surface-400">{i18n.t('aiServices.home.copy.supportedCapabilities')}</p>
        </button>
      </div>

      {mode === 'published' && (() => { const item = harnesses.find((candidate) => candidate.id === selectedId); const effective = item ? effectiveHarness(item) : null; return <div className="mt-3 border-y border-slate-200 py-3 dark:border-surface-800">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-bold text-slate-800 dark:text-surface-300">{i18n.t('aiServices.home.ui.currentCapability')}</span><span className="text-[10px] text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.capabilityRegistrySummary', { count: effective?.capabilityIds.length || 0 })}</span></div>
        <div className="mt-2 divide-y divide-slate-200 dark:divide-surface-800">
          {(effective?.capabilityIds || []).map((id) => { const capability = CAPABILITY_COPY[id] || { tool: id, label: id, detail: i18n.t('aiServices.home.publishedCapability') }; return <div key={id} className="flex items-start justify-between gap-3 py-2.5">
            <div><div className="text-xs font-semibold text-slate-800 dark:text-surface-200">{capability.label}</div><p className="mt-0.5 text-[11px] leading-5 text-slate-500 dark:text-surface-500">{capability.detail}</p></div>
            <div className="shrink-0 text-right"><div className="font-mono text-[10px] text-teal-700 dark:text-primary-300">{id}</div><div className="mt-1 font-mono text-[10px] text-slate-500 dark:text-surface-600">{capability.tool}</div></div>
          </div>; })}
        </div>
        <button type="button" onClick={onOpenDraft} className="mt-2 text-xs font-semibold text-amber-300 hover:text-amber-200">{i18n.t('aiServices.home.copy.createDraft')}</button>
      </div>; })()}

      {mode === 'custom-draft' && <div className="mt-3 border-y border-amber-500/25 bg-amber-500/5 px-1 py-3">
        <div className="text-xs font-bold text-amber-800 dark:text-amber-200">{i18n.t('aiServices.home.ui.unpublishedToolSystem')}</div>
        <p className="mt-1 text-[11px] leading-5 text-amber-900/70 dark:text-surface-400 [word-break:keep-all]">{i18n.t('aiServices.home.copy.unpublishedDescription')}</p>
      </div>}
    </div>
  );
}

function HarnessDraftHandoff({ projectId, baseHarness, onClose, onPublished }: { projectId: string; baseHarness?: PublishedHarness; onClose: () => void; onPublished: (item: PublishedHarness) => void }) {
  const [name, setName] = React.useState('customer-support-web');
  const [visibility, setVisibility] = React.useState<'project' | 'private'>('project');
  const [status, setStatus] = React.useState<'idle'|'creating'|'validating'|'publishing'>('idle');
  const [error, setError] = React.useState('');
  const publish = async () => {
    if (!projectId || !name.trim()) return;
    setError(''); setStatus('creating');
    const token = localStorage.getItem('token');
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    try {
      const profileId = `${harnessSlug(name)}-web`;
      const manifest = { schemaVersion: 2, engine: 'pi', runtimeProfile: { id: profileId, version: 1 }, defaultModel: 'litellm-responses/smart', allowedModels: ['litellm-responses/smart'], prompt: { includeAgentIdentity: true, includeProjectInstructions: false, includeMemory: false, includeSkills: false, components: [] }, capabilityIds: ['web.fetch','web.search'] };
      const draftRes = await fetch('/api/harnesses/drafts', { method: 'POST', headers, body: JSON.stringify({ name: name.trim(), ownerProjectId: projectId, visibility, baseHarnessId: baseHarness?.id, baseHarnessVersion: baseHarness?.current_version, manifest }) });
      const draft = await draftRes.json().catch(() => ({})); if (!draftRes.ok) throw new Error(draft.error || `Draft HTTP ${draftRes.status}`);
      setStatus('validating');
      const validationRes = await fetch(`/api/harnesses/drafts/${encodeURIComponent(draft.id)}/validate`, { method: 'POST', headers });
      const validation = await validationRes.json().catch(() => ({})); if (!validationRes.ok || validation.status !== 'valid') throw new Error(validation.error || validation.errors?.join(', ') || i18n.t('aiServices.home.harnessValidationFailed'));
      setStatus('publishing');
      const id = harnessSlug(name); if (!id) throw new Error(i18n.t('aiServices.home.harnessNameRequired'));
      const publishRes = await fetch(`/api/harnesses/drafts/${encodeURIComponent(draft.id)}/publish`, { method: 'POST', headers, body: JSON.stringify({ validationRunId: validation.id, expectedRevision: draft.revision, harnessId: id }) });
      const published = await publishRes.json().catch(() => ({})); if (!publishRes.ok) throw new Error(published.error || `Publish HTTP ${publishRes.status}`);
      onPublished({ id: published.harnessId, name: name.trim(), current_version: published.version, effective_manifest: { id: published.harnessId, version: published.version, runtimeProfileId: published.runtimeProfileId, runtimeProfileVersion: published.runtimeProfileVersion, engine: 'pi', defaultModel: 'litellm-responses/smart', capabilityIds: ['web.fetch','web.search'] } });
    } catch (err) { setError(err instanceof Error ? err.message : i18n.t('aiServices.home.harnessPublishFailed')); setStatus('idle'); }
  };
  return (
    <div className="absolute inset-0 z-10 flex items-end bg-slate-950/45 p-4 backdrop-blur-sm dark:bg-surface-950/90 sm:items-center sm:justify-center" role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="harness-draft-title" className="w-full rounded-xl border border-slate-200 bg-white p-4 text-slate-950 shadow-2xl dark:border-surface-700 dark:bg-surface-900 dark:text-surface-100 sm:max-w-md">
        <div className="flex items-start justify-between gap-4"><div><div className="text-[10px] font-bold uppercase tracking-[0.16em] text-amber-700 dark:text-amber-300">Harness draft</div><h3 id="harness-draft-title" className="mt-1 text-lg font-bold text-slate-950 dark:text-surface-100">{i18n.t('aiServices.home.copy.newToolSystemTitle')}</h3></div><button type="button" onClick={onClose} aria-label={i18n.t('aiServices.home.ui.close')} className="text-lg text-slate-400 hover:text-slate-700 dark:text-surface-500 dark:hover:text-surface-200">×</button></div>
        <p className="mt-3 text-xs leading-5 text-slate-600 dark:text-surface-400 [word-break:keep-all]">{i18n.t('aiServices.home.copy.draftDescription')}</p>
        <label className="mt-4 block text-xs font-semibold text-slate-700 dark:text-surface-300">{i18n.t('aiServices.home.ui.newHarnessName')}<input value={name} onChange={(event) => setName(event.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-amber-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100" /></label>
        <fieldset className="mt-4"><legend className="text-xs font-semibold text-slate-700 dark:text-surface-300">{i18n.t('aiServices.home.ui.scope')}</legend><div className="mt-2 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setVisibility('project')} aria-pressed={visibility === 'project'} className={`rounded-lg border p-2.5 text-left text-xs ${visibility === 'project' ? 'border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-500/45 dark:bg-amber-500/8 dark:text-amber-100' : 'border-slate-200 text-slate-600 dark:border-surface-700 dark:text-surface-400'}`}>{i18n.t('aiServices.home.ui.thisProject')}</button>
          <button type="button" onClick={() => setVisibility('private')} aria-pressed={visibility === 'private'} className={`rounded-lg border p-2.5 text-left text-xs ${visibility === 'private' ? 'border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-500/45 dark:bg-amber-500/8 dark:text-amber-100' : 'border-slate-200 text-slate-600 dark:border-surface-700 dark:text-surface-400'}`}>{i18n.t('aiServices.home.ui.private')}</button>
        </div></fieldset>
        <div className="mt-4 border-l-2 border-amber-500/60 pl-3 text-[11px] leading-5 text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.copy.draftPublishDescription')}</div>
        {error && <p className="mt-3 text-xs leading-5 text-red-700 dark:text-red-300">{error}</p>}
        <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onClose} disabled={status !== 'idle'} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 dark:border-surface-700 dark:bg-transparent dark:text-surface-300 dark:disabled:opacity-40">{i18n.t('aiServices.home.cancel')}</button><button type="button" disabled={!name.trim() || !projectId || status !== 'idle'} onClick={() => void publish()} className="rounded-lg border border-amber-400 bg-amber-600 px-3 py-2 text-xs font-bold text-white hover:bg-amber-500 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100 dark:disabled:opacity-40">{status === 'creating' ? i18n.t('aiServices.home.ui.savingDraft') : status === 'validating' ? i18n.t('aiServices.home.ui.validating') : status === 'publishing' ? i18n.t('aiServices.home.ui.publishing') : i18n.t('aiServices.home.ui.validatePublish')}</button></div>
      </section>
    </div>
  );
}

export function AIServiceHome() {
  const { t } = useTranslation('common');
  const canManage = getCurrentRole() === 'admin';
  const { services, loading, error, filter, setFilter, load } = useAIServiceStore();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [projectId, setProjectId] = React.useState('');
  const [projects, setProjects] = React.useState<Array<{id:string;name:string;rootPath?:string;agent?:{displayName?:string}}>>([]);
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState('');
  const [harnesses, setHarnesses] = React.useState<PublishedHarness[]>([]);
  const [selectedHarnessId, setSelectedHarnessId] = React.useState('quick-web-research');
  const [modelChoice, setModelChoice] = React.useState<'harness-default'|'smart'>('smart');
  const [shareMode, setShareMode] = React.useState<'unlisted'|'password'>('unlisted');
  const [sharePassword, setSharePassword] = React.useState('');
  const [knowledgePaths, setKnowledgePaths] = React.useState('');
  const [knowledgePickerOpen, setKnowledgePickerOpen] = React.useState(false);
  const [selectedServiceId, setSelectedServiceId] = React.useState<string | null>(null);

  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    const requestedProjectId = sessionStorage.getItem('tower-ai-service-create-project-id');
    if (!requestedProjectId) return;
    sessionStorage.removeItem('tower-ai-service-create-project-id');
    setProjectId(requestedProjectId);
    setCreateOpen(true);
  }, []);
  React.useEffect(() => {
    if (!createOpen) return;
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    void Promise.all([
      fetch('/api/projects', { headers }).then((response) => response.json()),
      fetch('/api/ai-services/harness-options', { headers }).then((response) => response.json()),
    ]).then(([projectData, harnessData]) => {
      const nextProjects = Array.isArray(projectData) ? projectData : Array.isArray(projectData.projects) ? projectData.projects : [];
      setProjects(nextProjects);
      if (projectId && !nextProjects.some((item: { id?: string }) => item.id === projectId)) setProjectId('');
      const next = Array.isArray(harnessData.harnesses) ? harnessData.harnesses : [];
      setHarnesses(next);
      if (next.length && !next.some((item: PublishedHarness) => item.id === selectedHarnessId)) setSelectedHarnessId(next[0].id);
    }).catch(() => { setProjects([]); setHarnesses([]); });
  }, [createOpen]);

  const closeCreate = () => {
    setCreateOpen(false);
    setCreateError('');
    setModelChoice('smart');
    setShareMode('unlisted');
    setSharePassword('');
    setKnowledgePaths('');
    setKnowledgePickerOpen(false);
  };

  const createService = async () => {
    if (!name.trim() || !projectId || (shareMode === 'password' && !sharePassword.trim())) return;
    const selected = harnesses.find((item) => item.id === selectedHarnessId);
    if (!selected) { setCreateError(i18n.t('aiServices.home.publishedHarnessRequired')); return; }
    const effective = effectiveHarness(selected);
    const selectedModel = modelChoice === 'smart' ? 'litellm-responses/smart' : effective.defaultModel;
    if (!effective.runtimeProfileId || !Number.isInteger(effective.runtimeProfileVersion) || effective.runtimeProfileVersion < 1) { setCreateError(i18n.t('aiServices.home.runtimeBindingRequired')); return; }
    setCreating(true);
    setCreateError('');
    try {
      const token = localStorage.getItem('token');
      const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      const selectedKnowledgePaths = [...new Set(knowledgePaths.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
      const response = await fetch('/api/ai-services', { method: 'POST', headers, body: JSON.stringify({ name: name.trim(), ownerProjectId: projectId, serviceType: 'customer', description: selectedKnowledgePaths.length ? i18n.t('aiServices.home.serviceDescriptionKnowledge') : i18n.t('aiServices.home.serviceDescriptionWeb') }) });
      const service = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(service.error || `HTTP ${response.status}`);
      const deployment = await fetch(`/api/ai-services/${encodeURIComponent(service.id)}/deployments`, {
        method: 'POST', headers, body: JSON.stringify({
          sourceSnapshot: selectedKnowledgePaths.length ? {
            kind: 'knowledge',
            version: 1,
            refs: selectedKnowledgePaths.map((path) => ({ path })),
          } : {
            kind: 'none',
            version: 1,
            refs: [],
            userFacingLabel: i18n.t('aiServices.home.noDeploymentMaterials'),
          },
          policySnapshot: {
            harnessBinding: { harnessId: effective.id, harnessVersion: effective.version, runtimeProfileId: effective.runtimeProfileId, runtimeProfileVersion: effective.runtimeProfileVersion, engine: effective.engine, model: selectedModel, status: 'published' },
            capabilityOverrides: [],
            // Server canonicalization replaces this preview with every concrete
            // tool compiled from the selected published Harness.
            allowedTools: effective.capabilityIds.map((id) => CAPABILITY_COPY[id]?.tool || id),
            refuseWithoutEvidence: true,
            conversationIsolation: 'per-visitor',
            learningFromConversations: false,
          },
          experienceSnapshot: { greeting: selectedKnowledgePaths.length ? i18n.t('aiServices.home.greetingKnowledge') : i18n.t('aiServices.home.greetingWeb') },
          evaluationSnapshot: { status: 'not_run', cases: [] },
        }),
      });
      const deploymentBody = await deployment.json().catch(() => ({}));
      if (!deployment.ok) throw new Error(deploymentBody.error || i18n.t('aiServices.home.ui.deploymentHttpError', { status: deployment.status }));
      const deployed = await fetch(`/api/ai-services/${encodeURIComponent(service.id)}/deploy-now`, { method: 'POST', headers, body: JSON.stringify({ deploymentId: deploymentBody.id }) });
      const deployedBody = await deployed.json().catch(() => ({}));
      if (!deployed.ok) throw new Error(deployedBody.error || i18n.t('aiServices.home.ui.deployHttpError', { status: deployed.status }));
      const overviewResponse = await fetch(`/api/ai-services/${encodeURIComponent(service.id)}`, { headers });
      const overview = await overviewResponse.json().catch(() => ({}));
      if (!overviewResponse.ok) throw new Error(overview.error || i18n.t('aiServices.home.ui.websiteCheckHttpError', { status: overviewResponse.status }));
      const website = Array.isArray(overview.channels) ? overview.channels.find((item: {channelType?:string;id?:string}) => item.channelType === 'web_link') : null;
      if (!website?.id) throw new Error(i18n.t('aiServices.home.websiteLinkFailed'));
      if (shareMode === 'password') {
        const access = await fetch(`/api/ai-services/${encodeURIComponent(service.id)}/channels/${encodeURIComponent(website.id)}/access`, { method: 'PUT', headers, body: JSON.stringify({ mode: 'password', password: sharePassword.trim() }) });
        const accessBody = await access.json().catch(() => ({}));
        if (!access.ok) throw new Error(accessBody.error || i18n.t('aiServices.home.ui.sharingSettingsHttpError', { status: access.status }));
      }
      closeCreate();
      setName('');
      setProjectId('');
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : i18n.t('aiServices.home.serviceCreateFailed'));
    } finally { setCreating(false); }
  };

  const visible = filter === 'all' ? services : services.filter((service) => operationalFilter(service) === filter);
  const selectedService = visible.find((service) => service.id === selectedServiceId) || visible[0] || null;
  React.useEffect(() => {
    if (selectedService && selectedService.id !== selectedServiceId) setSelectedServiceId(selectedService.id);
  }, [selectedService?.id, selectedServiceId]);
  const active = services.filter((service) => operationalFilter(service) === 'active').length;
  const review = services.filter((service) => operationalFilter(service) === 'review').length;
  const paused = services.filter((service) => operationalFilter(service) === 'paused').length;
  const preparing = services.filter((service) => operationalFilter(service) === 'draft').length;

  return (
    <main className="@container/deployment min-w-0 h-full overflow-auto bg-slate-50 px-4 py-5 text-slate-950 dark:bg-surface-950 dark:text-surface-100 sm:px-6 lg:px-8" lang={i18n.resolvedLanguage || i18n.language}>
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-col gap-4 border-b border-slate-200 pb-5 dark:border-surface-800 sm:flex-row sm:items-end sm:justify-between">
          <div><div className="text-[11px] font-bold uppercase tracking-[0.18em] text-teal-700 dark:text-primary-300">{i18n.t('aiServices.home.ui.externalDeployment')}</div><h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 dark:text-surface-100 [text-wrap:balance]">{i18n.t('aiServices.home.ui.externalDeployment')}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-surface-500 [word-break:keep-all]">{i18n.t('aiServices.home.copy.homeDescription')}</p></div>
          {canManage && <button type="button" onClick={() => setCreateOpen(true)} className="self-start rounded-xl border border-teal-300 bg-teal-50 px-4 py-2.5 text-sm font-bold text-teal-800 hover:bg-teal-100 dark:border-primary-400/35 dark:bg-primary-500/15 dark:text-primary-100 dark:hover:bg-primary-500/20">{i18n.t('aiServices.home.ui.newDeployment')}</button>}
        </header>

        <section className="grid grid-cols-2 gap-x-5 gap-y-4 border-b border-slate-200 py-5 dark:border-surface-800 sm:grid-cols-4">
          <div><div className="text-xs text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.all')}</div><div className="mt-1 text-xl font-bold text-slate-950 dark:text-surface-100">{services.length}</div></div>
          <div><div className="text-xs text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.running')}</div><div className="mt-1 text-xl font-bold text-emerald-700 dark:text-emerald-300">{active}</div></div>
          <div><div className="text-xs text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.deploymentPreparing')}</div><div className="mt-1 text-xl font-bold text-slate-700 dark:text-surface-300">{preparing + review}</div></div>
          <div><div className="text-xs text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.accessStopped')}</div><div className="mt-1 text-xl font-bold text-amber-700 dark:text-amber-300">{paused}</div></div>
        </section>

        <section className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-200 py-4 text-xs text-slate-600 dark:border-surface-800 dark:text-surface-400" aria-label={i18n.t('aiServices.home.ui.howTo')}>
          <strong className="text-slate-900 dark:text-surface-100">{i18n.t('aiServices.home.ui.howTo')}</strong><span>{i18n.t('aiServices.home.copy.stepOne')}</span><span>{i18n.t('aiServices.home.copy.stepTwo')}</span><span>{i18n.t('aiServices.home.copy.stepThree')}</span>
        </section>

        <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 py-3 dark:border-surface-800" aria-label={i18n.t('aiServices.home.ui.externalDeployment')}>
          {FILTER_IDS.map((key) => <button key={key} onClick={() => setFilter(key)} aria-pressed={filter === key} className={`whitespace-nowrap rounded-lg px-3 py-2 text-xs font-semibold ${filter === key ? 'bg-primary-50 text-primary-800 dark:bg-surface-800 dark:text-primary-200' : 'text-surface-500 hover:text-surface-200'}`}>{filterLabel(key)}</button>)}
        </nav>

        <section className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-surface-800 dark:bg-surface-900/45">
          {loading ? <div className="p-12 text-center text-sm text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.copy.loadingDeployments')}</div>
            : error ? <div className="p-10 text-center"><p className="text-sm text-red-700 dark:text-red-300">{error}</p><button onClick={() => void load()} className="mt-3 text-xs font-semibold text-primary-700 dark:text-primary-300">{i18n.t('aiServices.home.ui.retry')}</button></div>
            : visible.length === 0 ? <div className="p-12 text-center"><h2 className="font-bold text-slate-800 dark:text-surface-200">{services.length ? i18n.t('aiServices.home.copy.emptyFiltered') : i18n.t('aiServices.home.copy.emptyFirst')}</h2><p className="mt-2 text-sm text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.copy.emptyDescription')}</p></div>
            : <div className="grid min-h-[520px] @min-[64rem]/deployment:grid-cols-[280px_minmax(0,1fr)]">
              <aside className="border-b border-slate-200 dark:border-surface-800 @min-[64rem]/deployment:border-b-0 @min-[64rem]/deployment:border-r" aria-label={i18n.t('aiServices.home.ui.externalDeployment')}>
                <div className="border-b border-slate-200 px-4 py-3 text-xs font-bold text-slate-700 dark:border-surface-800 dark:text-surface-300">{i18n.t('aiServices.home.ui.deployedAgentCount', { count: visible.length })}</div>
                <div className="max-h-[72vh] overflow-y-auto">{visible.map((service) => <ServiceListItem key={service.id} service={service} selected={service.id === selectedService?.id} onSelect={() => setSelectedServiceId(service.id)} />)}</div>
              </aside>
              <div className="min-w-0 overflow-hidden">{selectedService && <ServiceRow key={selectedService.id} service={selectedService} canManage={canManage} />}</div>
            </div>}
        </section>
      </div>

      {knowledgePickerOpen && (() => { const project = projects.find((item) => item.id === projectId); return project?.rootPath ? <KnowledgeFilePicker project={{ rootPath: project.rootPath, name: project.agent?.displayName || project.name }} selected={knowledgePaths.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)} onApply={(paths) => { setKnowledgePaths(paths.join('\n')); setKnowledgePickerOpen(false); }} onClose={() => setKnowledgePickerOpen(false)} /> : null; })()}
      {canManage && createOpen && <div className="fixed inset-0 z-[120] grid place-items-center bg-black/65 p-4 backdrop-blur-sm" onClick={closeCreate}>
        <section className="relative max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 text-slate-950 shadow-2xl dark:border-surface-700 dark:bg-surface-900 dark:text-surface-100" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="create-ai-service-title">
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-teal-700 dark:text-primary-300">New External Deployment</div>
          <h2 id="create-ai-service-title" className="mt-1 text-xl font-bold text-slate-950 dark:text-surface-100 [text-wrap:balance]">{i18n.t('aiServices.home.copy.createTitle')}</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-surface-500 [word-break:keep-all]">{i18n.t('aiServices.home.copy.createDescription')}</p>
          <ol className="mt-4 grid gap-2 text-[11px] text-slate-600 dark:text-surface-400 sm:grid-cols-3" aria-label={i18n.t('aiServices.home.ui.deploymentStepsLabel')}>
            {[i18n.t('aiServices.home.ui.selectTeammate'), i18n.t('aiServices.home.ui.stepMaterials'), i18n.t('aiServices.home.ui.stepAccess')].map((step, index) => <li key={step} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-surface-800 dark:bg-surface-950/45"><span className="mr-2 font-bold text-teal-700 dark:text-primary-300">{index + 1}</span>{step}</li>)}
          </ol>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <label className="block text-sm font-semibold text-slate-700 dark:text-surface-300">{i18n.t('aiServices.home.ui.deploymentName')}<input value={name} onChange={(event) => setName(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-slate-900 outline-none placeholder:text-slate-400 focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" placeholder={i18n.t('aiServices.home.ui.deploymentNamePlaceholder')} /></label>
            <label className="block text-sm font-semibold text-slate-700 dark:text-surface-300">{i18n.t('aiServices.home.ui.selectTeammate')}<select value={projectId} onChange={(event) => setProjectId(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500"><option value="">{i18n.t('aiServices.home.ui.selectTeammate')}</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.agent?.displayName || project.name}</option>)}</select></label>
          </div>
          <fieldset className="mt-5"><legend className="text-sm font-bold text-slate-800 dark:text-surface-200">{i18n.t('aiServices.home.ui.aiModel')}</legend><div className="mt-2 grid gap-2 sm:grid-cols-2">
            <button type="button" onClick={() => setModelChoice('smart')} aria-pressed={modelChoice === 'smart'} className={`rounded-xl border p-3 text-left ${modelChoice === 'smart' ? 'border-teal-400 bg-teal-50 dark:border-primary-500/45 dark:bg-primary-500/10' : 'border-slate-200 bg-white dark:border-surface-700 dark:bg-surface-950/45'}`}><span className="block text-sm font-bold text-slate-900 dark:text-surface-100">Smart</span><span className="mt-1 block text-xs text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.copy.smartDescription')}</span></button>
            <button type="button" onClick={() => setModelChoice('harness-default')} aria-pressed={modelChoice === 'harness-default'} className={`rounded-xl border p-3 text-left ${modelChoice === 'harness-default' ? 'border-teal-400 bg-teal-50 dark:border-primary-500/45 dark:bg-primary-500/10' : 'border-slate-200 bg-white dark:border-surface-700 dark:bg-surface-950/45'}`}><span className="block text-sm font-bold text-slate-900 dark:text-surface-100">{i18n.t('aiServices.home.ui.harnessDefault')}</span><span className="mt-1 block text-xs text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.copy.harnessModelDescription')}</span></button>
          </div></fieldset>
          <fieldset className="mt-5"><legend className="text-sm font-bold text-slate-800 dark:text-surface-200">{i18n.t('aiServices.home.ui.answerMaterials')}</legend>
            <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-surface-800 dark:bg-surface-950/45">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-sm font-bold text-slate-900 dark:text-surface-100">{i18n.t('aiServices.home.ui.connectMaterials')}</div><p className="mt-1 max-w-lg text-xs leading-5 text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.copy.materialsDescription')}</p></div><span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-1 text-[10px] font-bold text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">Markdown · TXT</span></div>
              <button type="button" disabled={!projectId || !projects.find((item) => item.id === projectId)?.rootPath} onClick={() => setKnowledgePickerOpen(true)} className="mt-3 rounded-lg border border-teal-300 bg-white px-3 py-2 text-xs font-bold text-teal-800 hover:bg-teal-50 disabled:border-slate-200 disabled:text-slate-400 dark:border-primary-500/35 dark:bg-transparent dark:text-primary-200">{i18n.t('aiServices.home.ui.selectInFinder')}</button>
              {knowledgePaths ? <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-surface-800 dark:bg-surface-900"><div className="text-xs font-bold text-slate-700 dark:text-surface-300">{i18n.t('aiServices.home.ui.selectedMaterialCount', { count: knowledgePaths.split(/\r?\n/).filter(Boolean).length })}</div><ul className="mt-2 max-h-28 space-y-1 overflow-y-auto font-mono text-[11px] text-slate-500 dark:text-surface-500">{knowledgePaths.split(/\r?\n/).filter(Boolean).map((item) => <li key={item} className="truncate">{item}</li>)}</ul><button type="button" onClick={() => setKnowledgePaths('')} className="mt-2 text-[11px] font-semibold text-red-600 dark:text-red-300">{i18n.t('aiServices.home.ui.clearSelection')}</button></div> : <p className="mt-3 text-xs text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.ui.noSelectedMaterials')}</p>}
              <details className="mt-2"><summary className="cursor-pointer text-[11px] font-semibold text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.ui.advancedPath')}</summary><textarea value={knowledgePaths} onChange={(event) => setKnowledgePaths(event.target.value)} rows={3} className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 outline-none placeholder:text-slate-400 focus:border-teal-500 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-100" placeholder={'knowledge/guide.md\nfinal/customer-faq.txt'} /></details>
              <p className="mt-2 text-[11px] leading-5 text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.copy.materialsSafety')}</p>
            </div>
          </fieldset>
          <fieldset className="mt-5"><legend className="text-sm font-bold text-slate-800 dark:text-surface-200">{i18n.t('aiServices.home.ui.whoCanUse')}</legend><div className="mt-2 grid gap-2 sm:grid-cols-2">
            <button type="button" onClick={() => setShareMode('unlisted')} aria-pressed={shareMode === 'unlisted'} className={`rounded-xl border p-3 text-left ${shareMode === 'unlisted' ? 'border-teal-400 bg-teal-50 dark:border-primary-500/45 dark:bg-primary-500/10' : 'border-slate-200 bg-white dark:border-surface-700 dark:bg-surface-950/45'}`}><span className="block text-sm font-bold text-slate-900 dark:text-surface-100">{i18n.t('aiServices.home.ui.peopleWithLink')}</span><span className="mt-1 block text-xs text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.copy.linkDefaultDescription')}</span></button>
            <button type="button" onClick={() => setShareMode('password')} aria-pressed={shareMode === 'password'} className={`rounded-xl border p-3 text-left ${shareMode === 'password' ? 'border-teal-400 bg-teal-50 dark:border-primary-500/45 dark:bg-primary-500/10' : 'border-slate-200 bg-white dark:border-surface-700 dark:bg-surface-950/45'}`}><span className="block text-sm font-bold text-slate-900 dark:text-surface-100">{i18n.t('aiServices.home.ui.peopleWithPassword')}</span><span className="mt-1 block text-xs text-slate-500 dark:text-surface-500">{i18n.t('aiServices.home.copy.passwordDescription')}</span></button>
          </div></fieldset>
          {shareMode === 'password' && <label className="mt-3 block text-sm font-semibold text-slate-700 dark:text-surface-300">{i18n.t('aiServices.home.ui.sharePassword')}<input value={sharePassword} onChange={(event) => setSharePassword(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-slate-900 outline-none placeholder:text-slate-400 focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" placeholder={i18n.t('aiServices.home.ui.sharePasswordPlaceholder')} /></label>}
          <section className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-surface-800 dark:bg-surface-950/45" aria-label={i18n.t('aiServices.home.ui.deploymentSummary')}><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-bold text-slate-900 dark:text-surface-100">{i18n.t('aiServices.home.ui.deploymentSummary')}</h3><span className="text-[10px] font-bold text-teal-700 dark:text-primary-300">{i18n.t('aiServices.home.ui.deploymentFinalReview')}</span></div><dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2"><div><dt className="text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.materialsSystems')}</dt><dd className="mt-1 font-semibold text-slate-800 dark:text-surface-200">{knowledgePaths ? i18n.t('aiServices.home.ui.selectedLiterature', { count: knowledgePaths.split(/\r?\n/).filter(Boolean).length }) : i18n.t('aiServices.home.ui.noMaterialsConnected')} · {i18n.t('aiServices.home.ui.noExternalSystems')}</dd></div><div><dt className="text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.possibleWork')}</dt><dd className="mt-1 font-semibold text-slate-800 dark:text-surface-200">{i18n.t('aiServices.home.ui.answerFromMaterials')}</dd></div><div><dt className="text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.ui.externalUsers')}</dt><dd className="mt-1 font-semibold text-slate-800 dark:text-surface-200">{shareMode === 'password' ? i18n.t('aiServices.home.ui.peopleWithPassword') : i18n.t('aiServices.home.ui.peopleWithLink')}</dd></div></dl><div className="mt-3 rounded-lg bg-white px-3 py-2 text-[11px] leading-5 text-slate-500 ring-1 ring-slate-200 dark:bg-surface-900 dark:text-surface-500 dark:ring-surface-800">{i18n.t('aiServices.home.ui.impossibleActions')}</div></section>
          {createError && <p className="mt-3 text-sm text-red-700 dark:text-red-300">{createError}</p>}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4 dark:border-surface-800">
            <p className="max-w-sm text-[11px] leading-5 text-slate-500 dark:text-surface-600">{i18n.t('aiServices.home.copy.openAfterDeploy')}</p>
            <div className="flex gap-2"><button type="button" onClick={closeCreate} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 dark:border-surface-700 dark:bg-transparent dark:text-surface-300">{i18n.t('aiServices.home.cancel')}</button><button type="button" disabled={creating || !name.trim() || !projectId || (shareMode === 'password' && !sharePassword.trim())} onClick={() => void createService()} className="rounded-lg border border-teal-300 bg-teal-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-teal-500 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:border-primary-400/35 dark:bg-primary-500/15 dark:text-primary-100 dark:disabled:opacity-40">{creating ? i18n.t('aiServices.home.ui.deploying') : i18n.t('aiServices.home.ui.externalDeployment')}</button></div>
          </div>
        </section>
      </div>}
    </main>
  );
}

export default AIServiceHome;
