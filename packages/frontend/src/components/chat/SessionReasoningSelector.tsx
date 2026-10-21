import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/session-store';
import { modelIdFromSession, useModelStore, type EffortLevel } from '../../stores/model-store';

export function SessionReasoningSelector({ variant = 'inline', onComplete }: { variant?: 'inline' | 'model-menu'; onComplete?: () => void }) {
  const { t } = useTranslation('chat');
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const session = useSessionStore((s) => s.sessions.find((item) => item.id === s.activeSessionId));
  const updateSessionMeta = useSessionStore((s) => s.updateSessionMeta);
  const piModels = useModelStore((s) => s.piModels);
  const selectedModel = useModelStore((s) => s.selectedModel);
  const [saving, setSaving] = useState(false);
  if (!activeSessionId || session?.engine !== 'pi') return null;

  const modelId = modelIdFromSession(session) ?? selectedModel;
  const efforts = piModels.find((model) => model.id === modelId)?.reasoningEfforts ?? [];
  if (efforts.length === 0) return null;
  const value = session.reasoningEffort && efforts.includes(session.reasoningEffort) ? session.reasoningEffort : '';
  const change = async (next: string) => {
    const previous = session.reasoningEffort ?? null;
    const reasoningEffort = next === '' ? null : next as EffortLevel;
    updateSessionMeta(activeSessionId, { reasoningEffort });
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/sessions/${activeSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ reasoningEffort }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      onComplete?.();
    } catch {
      updateSessionMeta(activeSessionId, { reasoningEffort: previous });
    } finally {
      setSaving(false);
    }
  };

  if (variant === 'model-menu') {
    return (
      <label className="mx-2 mb-1 block rounded-lg border border-primary-500/20 bg-primary-500/[0.05] px-3 py-2.5">
        <span className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-[12px] font-medium text-surface-300">{t('sessionReasoning')}</span>
            <span className="mt-0.5 block text-[10px] leading-4 text-surface-500">{t('sessionReasoningDescription')}</span>
          </span>
          <select
            aria-label={t('sessionReasoning')}
            className="min-h-8 max-w-[132px] shrink-0 rounded-md border border-surface-700 bg-surface-800 px-2 text-[12px] text-surface-200 outline-none focus:border-primary-500 disabled:opacity-50"
            value={value}
            disabled={saving}
            onChange={(event) => void change(event.target.value)}
          >
            <option value="">{t('reasoningDefault')}</option>
            {efforts.map((effort) => <option key={effort} value={effort}>{t(`reasoning_${effort}`)}</option>)}
          </select>
        </span>
      </label>
    );
  }

  return (
    <label className="flex shrink-0 items-center gap-1 text-[11px] text-surface-500">
      <span className="sr-only">{t('sessionReasoning')}</span>
      <select aria-label={t('sessionReasoning')} value={value} disabled={saving} onChange={(event) => void change(event.target.value)}>
        <option value="">{t('reasoningDefault')}</option>
        {efforts.map((effort) => <option key={effort} value={effort}>{t(`reasoning_${effort}`)}</option>)}
      </select>
    </label>
  );
}
