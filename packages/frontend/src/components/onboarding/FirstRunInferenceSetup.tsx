import { useState } from 'react';
import { useTranslation } from 'react-i18next';

const API_BASE = '/api';

type Provider = 'openrouter' | 'openai-responses-compatible';

interface ProviderDraft {
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  modelId: string;
}

const PROVIDERS: Record<Provider, Omit<ProviderDraft, 'provider' | 'apiKey'>> = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    modelId: 'openrouter/auto',
  },
  'openai-responses-compatible': {
    baseUrl: 'https://api.openai.com/v1',
    modelId: 'gpt-5.6-terra',
  },
};

function providerDraft(provider: Provider): ProviderDraft {
  return { provider, apiKey: '', ...PROVIDERS[provider] };
}

export function FirstRunInferenceSetup({ token, onComplete }: { token: string; onComplete: (result: { model: string; project: any; session: any }) => void }) {
  const { t } = useTranslation('onboarding');
  const [draft, setDraft] = useState<ProviderDraft>(() => providerDraft('openrouter'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const updateProvider = (provider: Provider) => {
    setDraft(providerDraft(provider));
    setError('');
  };

  const connect = async () => {
    if (!draft.apiKey.trim()) {
      setError(t('provider.apiKeyRequired'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${API_BASE}/admin/inference-setup/apply`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(draft),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || t('provider.connectionFailed'));
      setDraft((current) => ({ ...current, apiKey: '' }));
      const projectsResponse = await fetch(`${API_BASE}/projects`, { headers: { Authorization: `Bearer ${token}` } });
      const projects = await projectsResponse.json().catch(() => []);
      if (!projectsResponse.ok) throw new Error(projects?.error || t('provider.firstAgentFailed'));
      const sourceProject = projects.find((project: any) => project.systemKey === 'general' || String(project.name).toLowerCase() === 'general') || projects[0];
      if (!sourceProject?.id) throw new Error(t('provider.firstAgentFailed'));
      const agentResponse = await fetch(`${API_BASE}/primary-agent-commands/bootstrap`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceProjectId: sourceProject.id,
          name: t('provider.firstAgent.name'),
          face: 'character:core-talent',
          expectedExpertise: t('provider.firstAgent.expertise'),
        }),
      });
      const agent = await agentResponse.json().catch(() => ({}));
      if (!agentResponse.ok) throw new Error(agent?.error || t('provider.firstAgentFailed'));
      onComplete({ model: String(data.model || draft.modelId), project: agent.project, session: agent.session });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('provider.connectionFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-bg fixed inset-0 z-[120] overflow-y-auto px-4 py-8 text-surface-100 [word-break:keep-all] [overflow-wrap:break-word] sm:px-6">
      <main className="mx-auto flex min-h-full max-w-2xl items-center justify-center">
        <section aria-labelledby="first-run-provider-title" className="w-full rounded-2xl border border-surface-700 bg-surface-900/95 p-5 shadow-2xl shadow-black/25 sm:p-8">
          <div className="flex items-start gap-4">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary-500/12 text-primary-300 ring-1 ring-primary-500/25" aria-hidden="true">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v3m0 12v3M3 12h3m12 0h3M5.64 5.64l2.12 2.12m8.48 8.48 2.12 2.12m0-12.72-2.12 2.12M7.76 16.24l-2.12 2.12M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z" /></svg>
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-primary-300">{t('provider.step')}</div>
              <h1 id="first-run-provider-title" className="mt-1 text-2xl font-bold tracking-tight text-surface-50 text-balance">{t('provider.title')}</h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-surface-400 text-pretty">{t('provider.description')}</p>
            </div>
          </div>

          <div className="mt-5 rounded-xl border border-surface-800 bg-surface-950/40 px-4 py-3 text-xs leading-5 text-surface-500">
            {t('provider.optionalWebSearch')}
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label={t('provider.choose')}>
            {(['openrouter', 'openai-responses-compatible'] as Provider[]).map((provider) => {
              const selected = draft.provider === provider;
              return (
                <button key={provider} type="button" role="radio" aria-checked={selected} onClick={() => updateProvider(provider)} className={`rounded-xl border px-4 py-3 text-left transition-colors ${selected ? 'border-primary-500/60 bg-primary-500/10 text-surface-100' : 'border-surface-700 bg-surface-950/55 text-surface-400 hover:border-surface-600'}`}>
                  <span className="block text-sm font-bold">{t(`provider.options.${provider}.name`)}</span>
                  <span className="mt-1 block text-xs leading-5 text-surface-500">{t(`provider.options.${provider}.description`)}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-6 space-y-4">
            <label className="block">
              <span className="text-sm font-semibold text-surface-200">{t('provider.apiKey')}</span>
              <input type="password" autoComplete="off" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder={t('provider.apiKeyPlaceholder')} className="mt-2 h-11 w-full rounded-xl border border-surface-700 bg-surface-950 px-3 text-sm text-surface-100 outline-none placeholder:text-surface-650 focus:border-primary-500/70 focus:ring-2 focus:ring-primary-500/15" />
              <span className="mt-2 block text-xs leading-5 text-surface-500">{t('provider.secretNote')}</span>
            </label>
            <div className="rounded-xl border border-surface-800 bg-surface-950/40 px-4 py-3 text-xs leading-5 text-surface-500">
              {t('provider.modelAutomatic', { model: draft.modelId })}
            </div>
          </div>

          {error && <div role="alert" className="mt-4 rounded-xl border border-red-500/25 bg-red-500/8 px-4 py-3 text-sm leading-5 text-red-200">{error}</div>}

          <div className="mt-7 flex flex-col-reverse gap-3 border-t border-surface-800 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-5 text-surface-550">{t('provider.next')}</p>
            <button type="button" onClick={connect} disabled={busy} className="min-h-11 shrink-0 rounded-xl bg-primary-600 px-5 text-sm font-bold text-white transition-colors hover:bg-primary-500 disabled:cursor-wait disabled:opacity-60">
              {busy ? t('provider.connecting') : t('provider.connect')}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
