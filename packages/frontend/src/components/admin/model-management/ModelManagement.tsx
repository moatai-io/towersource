import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ModelDefaultSelect } from '../ModelDefaultSelect';

const API_BASE = '/api';

// ───── AI Settings Management ─────

export function AiSettingsManagement({ token, canEditReasoning = false }: { token?: string | null; canEditReasoning?: boolean }) {
  const { t } = useTranslation('admin');
  return (
    <div className="space-y-8">
      <header className="max-w-3xl">
        <h2 className="text-[20px] font-semibold text-surface-100">{t('aiOperationsTitle')}</h2>
        <p className="mt-1 text-[14px] leading-6 text-surface-400">{t('aiOperationsIntro')}</p>
      </header>

      <section>
        <ModelManagement token={token} canEditReasoning={canEditReasoning} />
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
  hidden?: boolean;
  selectable?: boolean;
  teamVerifiedAt?: string;
  api?: string;
  reasoning?: boolean;
  defaultReasoning?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  reasoningEfforts?: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
  contextWindow?: number;
  maxTokens?: number;
  roles?: string[];
  _note?: string;
}
interface ModelDefaults { session: string; ai_reply: string; ai_task: string }
interface ModelsData { claude: ClaudeModelEntry[]; pi: PiModelEntry[]; defaults?: ModelDefaults }
interface LiteLLMCatalogModel { modelId: string; name: string; ownedBy?: string; kind: 'policy' | 'direct'; enabled: boolean; selectable: boolean; lastSeenAt?: string }
interface LiteLLMCatalog { models: LiteLLMCatalogModel[]; syncedAt?: string; syncError?: string }

function ModelManagement({ token, canEditReasoning }: { token?: string | null; canEditReasoning: boolean }) {
  const { t } = useTranslation('admin');
  const [models, setModels] = useState<ModelsData | null>(null);
  const [inferenceReadiness, setInferenceReadiness] = useState<{ status: 'ready' | 'setup_required' | 'invalid'; defaultModel: string; readyProviders: string[]; nextAction: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [litellmCatalog, setLiteLLMCatalog] = useState<LiteLLMCatalog | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [modelLoadError, setModelLoadError] = useState(false);
  const [catalogLoadError, setCatalogLoadError] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState<string | null>(null);
  const [routerKeyName, setRouterKeyName] = useState<string | null>(null);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const fetchModels = useCallback(async () => {
    setModelsLoading(true);
    setModelLoadError(false);
    try {
      const response = await fetch(`${API_BASE}/admin/models`, { headers });
      if (!response.ok) throw new Error('models unavailable');
      const data = await response.json();
      if (!Array.isArray(data.pi)) throw new Error('invalid models');
      setModels(data);
    } catch { setModelLoadError(true); }
    finally { setModelsLoading(false); }
  }, [token]);

  const fetchLiteLLMCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogLoadError(false);
    try {
      const response = await fetch(`${API_BASE}/admin/ai-models/litellm-catalog`, { headers });
      if (!response.ok) throw new Error('catalog unavailable');
      const data = await response.json();
      if (!Array.isArray(data.models)) throw new Error('invalid catalog');
      setLiteLLMCatalog(data);
    } catch { setCatalogLoadError(true); }
    finally { setCatalogLoading(false); }
  }, [token]);

  useEffect(() => {
    fetchModels();
    fetchLiteLLMCatalog();
    fetch(`${API_BASE}/admin/ai-models/router-connection`, { headers })
      .then(r => r.ok ? r.json() : null)
      .then(d => setRouterKeyName(d?.keyName ?? null))
      .catch(() => {});
    fetch(`${API_BASE}/config`, { headers })
      .then(r => r.ok ? r.json() : null)
      .then(d => d?.inferenceReadiness && setInferenceReadiness(d.inferenceReadiness))
      .catch(() => {});
  }, [fetchModels, fetchLiteLLMCatalog]);

  const refreshLiteLLMCatalog = async () => {
    setCatalogBusy('refresh');
    try {
      const response = await fetch(`${API_BASE}/admin/ai-models/litellm-catalog/refresh`, { method: 'POST', headers });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('litellmCatalogRefreshFailed'));
      setLiteLLMCatalog(data);
      setCatalogLoadError(false);
      await fetchModels();
    } catch (error) {
      setSaveMessage({ ok: false, text: error instanceof Error ? error.message : t('litellmCatalogRefreshFailed') });
    } finally { setCatalogBusy(null); }
  };

  const saveReasoning = async (modelId: string, defaultReasoning: 'low' | 'medium' | 'high' | 'xhigh' | 'max') => {
    setSaving(true);
    setSaveMessage(null);
    try {
      const response = await fetch(`${API_BASE}/admin/models/reasoning`, { method: 'PATCH', headers, body: JSON.stringify({ provider: 'litellm-responses', modelId, defaultReasoning }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('modelSaveFailed'));
      setModels(previous => previous ? { ...previous, pi: previous.pi.map(model => model.provider === 'litellm-responses' && model.modelId === modelId ? { ...model, defaultReasoning: data.defaultReasoning } : model) } : previous);
      setSaveMessage({ ok: true, text: t('modelSaveComplete') });
    } catch (error) {
      setSaveMessage({ ok: false, text: error instanceof Error ? error.message : t('modelSaveFailed') });
    } finally { setSaving(false); }
  };

  const saveDefaults = async (key: 'session' | 'ai_task', model: string) => {
    setSaving(true);
    setSaveMessage(null);
    try {
      const response = await fetch(`${API_BASE}/admin/models/defaults`, { method: 'PATCH', headers, body: JSON.stringify({ key, model }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('modelSaveFailed'));
      setModels(previous => previous ? { ...previous, defaults: data.defaults } : previous);
      setSaveMessage({ ok: true, text: t('modelSaveComplete') });
    } catch (error) {
      setSaveMessage({ ok: false, text: error instanceof Error ? error.message : t('modelSaveFailed') });
    } finally { setSaving(false); }
  };

  if (!models) return <div className="text-gray-500 text-base py-8 text-center">{t(modelLoadError ? 'modelDefaultsLoadFailed' : 'common:loading')}</div>;

  const toggleClass = (on: boolean) =>
    `w-9 h-5 rounded-full relative cursor-pointer transition-colors ${on ? 'bg-primary-500' : 'bg-surface-600'}`;
  const dotClass = (on: boolean) =>
    `absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${on ? 'left-4' : 'left-0.5'}`;

  const currentDefaults: ModelDefaults = models.defaults ?? { session: '', ai_reply: '', ai_task: '' };
  const defaultsReady = !modelsLoading && !catalogLoading && !modelLoadError && !catalogLoadError && !!litellmCatalog && !catalogBusy;
  const modelDisplayName = (id: string) => models.pi.find(model => `${model.provider}/${model.modelId}` === id)?.name ?? (id || t('modelDefaultUnset'));
  const catalogModelIds = new Set((litellmCatalog?.models ?? []).filter(model => model.selectable).map(model => model.modelId));
  const selectableModels = models.pi.filter(model => model.enabled
    && model.provider === 'litellm-responses'
    && catalogModelIds.has(model.modelId));

  const readinessStatus = inferenceReadiness?.status ?? 'ready';
  const statusTone = readinessStatus === 'ready'
    ? 'border-emerald-500/25 bg-emerald-500/8 text-emerald-200'
    : readinessStatus === 'invalid'
      ? 'border-red-500/25 bg-red-500/8 text-red-200'
      : 'border-amber-500/25 bg-amber-500/8 text-amber-200';

  return (
    <div className="space-y-8">
      <section className={`rounded-xl border p-5 ${statusTone}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${readinessStatus === 'ready' ? 'bg-emerald-400' : readinessStatus === 'invalid' ? 'bg-red-400' : 'bg-amber-400'}`} />
              <h3 className="text-[16px] font-semibold">{t('aiStatusTitle')}</h3>
            </div>
            <p className="mt-2 text-[14px] opacity-80">{readinessStatus === 'ready' ? t('aiStatusReady') : inferenceReadiness?.nextAction || t('aiStatusNeedsSetup')}</p>
          </div>
          <span className="rounded-full border border-current/20 px-2.5 py-1 text-[12px] font-semibold">
            {readinessStatus === 'ready' ? t('statusReady') : readinessStatus === 'invalid' ? t('statusUnavailable') : t('statusNeedsAttention')}
          </span>
        </div>
        <dl className="mt-5 grid gap-x-6 gap-y-4 border-t border-current/15 pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-[12px] opacity-60">{t('primaryWorkModel')}</dt><dd className="mt-1 truncate text-[14px] font-medium" title={modelDisplayName(currentDefaults.session)}>{modelDisplayName(currentDefaults.session)}</dd></div>
          <div><dt className="text-[12px] opacity-60">{t('utilityWorkModel')}</dt><dd className="mt-1 truncate text-[14px] font-medium" title={modelDisplayName(currentDefaults.ai_task)}>{modelDisplayName(currentDefaults.ai_task)}</dd></div>
          <div><dt className="text-[12px] opacity-60">{t('defaultExecutionPath')}</dt><dd className="mt-1 truncate text-[14px] font-medium">{t('moatAiRouter')}</dd></div>
          <div><dt className="text-[12px] opacity-60">{t('routerKeyName')}</dt><dd className="mt-1 truncate font-mono text-[13px]" title={routerKeyName ?? undefined}>{routerKeyName ?? t('routerKeyUnavailable')}</dd></div>
        </dl>
      </section>

      <section>
        <div className="mb-3">
          <h3 className="text-[16px] font-semibold text-surface-100">{t('modelPolicyTitle')}</h3>
          <p className="mt-1 text-[13px] leading-5 text-surface-500">{t('modelPolicyIntro')}</p>
        </div>
        <div className="bg-surface-800/50 rounded-lg border border-surface-700 divide-y divide-surface-700/50">
          {([
            { key: 'session' as const, label: t('primaryWorkModel'), desc: t('sessionModelDesc') },
            { key: 'ai_task' as const, label: t('utilityWorkModel'), desc: t('aiReplyModelDesc') },
          ]).map(({ key, label, desc }) => {
            const options = selectableModels;
            return (
              <div key={key} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center">
                <div className="flex-1 min-w-0">
                  <div className="text-[15px] text-gray-200 font-medium">{label}</div>
                  <div className="mt-0.5 text-[13px] leading-5 text-gray-500">{desc}</div>
                  <div className="mt-1 break-all text-[12px] text-surface-400">{t('modelDefaultSaved', { model: currentDefaults[key] || t('modelDefaultUnset') })}</div>
                </div>
                <ModelDefaultSelect value={currentDefaults[key]} label={label}
                  options={options.map(o => ({ value: `${o.provider}/${o.modelId}`, label: o.name }))}
                  ready={defaultsReady} disabled={saving}
                  missingLabel={t(!defaultsReady ? 'modelDefaultPending' : 'modelDefaultNotListed', { model: modelDisplayName(currentDefaults[key]) })}
                  onChange={value => void saveDefaults(key, value)} />
              </div>
            );
          })}
        </div>
        {(modelLoadError || catalogLoadError) && <p role="alert" className="mt-2 text-[12px] text-amber-400">{t('modelDefaultsLoadFailed')}</p>}
        {(modelsLoading || catalogLoading || catalogBusy) && <p role="status" className="mt-2 text-[12px] text-surface-400">{t('common:loading')}</p>}
        <p className="mt-2 text-[12px] text-surface-600">{t('modelPolicyApplyHint')}</p>
      </section>

      <section className="border-t border-surface-800 pt-6">
        <h3 className="text-[16px] font-semibold text-surface-100">{t('modelReasoningTitle')}</h3>
        <p className="mt-1 mb-3 text-[13px] text-surface-500">{t('modelReasoningIntro')}</p>
        <div className="divide-y divide-surface-700/50 rounded-lg border border-surface-700 bg-surface-800/50">
          {models.pi.filter(model => model.provider === 'litellm-responses' && model.enabled && model.reasoning && (catalogModelIds.has(model.modelId) || currentDefaults.session === `${model.provider}/${model.modelId}` || currentDefaults.ai_task === `${model.provider}/${model.modelId}`)).map(model => (
            <div key={model.modelId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0"><div className="text-[14px] text-surface-200">{model.name}</div><div className="break-all font-mono text-[11px] text-surface-500">{model.provider}/{model.modelId}</div></div>
              <select aria-label={t('defaultReasoningForModel', { name: model.name })} value={model.defaultReasoning ?? 'medium'} disabled={saving || !defaultsReady || !canEditReasoning} onChange={event => void saveReasoning(model.modelId, event.target.value as 'low' | 'medium' | 'high' | 'xhigh' | 'max')} className="min-h-9 rounded-md border border-surface-600 bg-surface-800 px-3 text-[13px] text-surface-100 disabled:opacity-50">
                {(model.reasoningEfforts?.length ? model.reasoningEfforts : ['low', 'medium', 'high']).map(level => <option key={level} value={level}>{level}</option>)}
              </select>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-surface-800 pt-6">
        <div className="mb-3">
          <h3 className="text-[16px] font-semibold text-surface-100">{t('availableModels')}</h3>
          <p className="mt-1 text-[13px] leading-5 text-surface-500">{t('availableModelsIntro')}</p>
        </div>

      {/* LiteLLM discovered catalog */}
      <div className="mb-6 border-b border-surface-800 pb-6">
        <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
          <div><h3 className="text-[15px] font-semibold text-gray-300">{t('litellmCatalog')}</h3><p className="mt-1 text-[12px] text-surface-500">{t('litellmCatalogIntro')}</p></div>
          <button type="button" disabled={catalogBusy !== null} onClick={() => void refreshLiteLLMCatalog()} className="min-h-9 rounded-md border border-surface-600 px-3 text-[13px] font-semibold text-surface-200 hover:bg-surface-800 disabled:opacity-50">{catalogBusy === 'refresh' ? t('litellmCatalogRefreshing') : t('litellmCatalogRefresh')}</button>
        </div>
        <div className="mb-2 text-[11px] text-surface-600">{litellmCatalog?.syncedAt ? t('litellmCatalogSyncedAt', { time: new Date(litellmCatalog.syncedAt).toLocaleString() }) : t('litellmCatalogNotSynced')}</div>
        <div className="overflow-hidden rounded-lg border border-surface-700 bg-surface-800/35">
          {(litellmCatalog?.models ?? []).map(model => <div key={model.modelId} className="flex items-center gap-3 border-b border-surface-800 px-4 py-2.5 last:border-0"><span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" aria-hidden="true" /><div className="min-w-0 flex-1"><div className="truncate text-[14px] text-surface-200">{model.name}</div><div className="truncate font-mono text-[11px] text-surface-600">{model.modelId}</div></div><span className="rounded bg-surface-700 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-surface-400">{model.ownedBy || t('directModel')}</span></div>)}
          {(litellmCatalog?.models.length ?? 0) === 0 && <div className="px-4 py-5 text-center text-[13px] text-surface-500">{t('litellmCatalogEmpty')}</div>}
        </div>
      </div>

      {saving && <div className="text-[14px] text-primary-400 text-center">{t('common:saving')}</div>}
      {saveMessage && <div role="status" className={`mt-3 rounded-lg border px-3 py-2 text-[13px] ${saveMessage.ok ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200' : 'border-red-500/25 bg-red-500/10 text-red-200'}`}>{saveMessage.text}</div>}
      </section>
    </div>
  );
}
