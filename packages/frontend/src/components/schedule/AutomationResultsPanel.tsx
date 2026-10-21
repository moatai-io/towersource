import type { AutomationRun } from '@tower/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

export type AutomationResultItem = {
  automationId: string;
  automationName: string;
  projectId: string | null;
  run: AutomationRun;
  executionStatus?: string;
  sessionId?: string | null;
  outcomeUnverified?: boolean;
  receipt?: { readAt: string | null; actionedAt: string | null };
};

const attentionStatuses = new Set(['failed', 'timeout', 'timed_out', 'uncertain', 'cancelled', 'canceled']);

export function resultStatus(item: AutomationResultItem): string {
  const runStatus = item.run.status.toLowerCase();
  if (runStatus === 'none') return 'none';
  if (item.outcomeUnverified && ['success', 'succeeded', 'spawned'].includes(runStatus)) return 'unverified';
  // A live run must not be displayed as a completed result from stale execution metadata.
  if (['in_progress', 'running', 'pending', 'queued'].includes(runStatus)) return runStatus;
  return (item.executionStatus || runStatus).toLowerCase();
}

export function resultNeedsAttention(item: AutomationResultItem): boolean {
  return attentionStatuses.has(resultStatus(item));
}

export function resultStatusLabel(status: string, t: (key: string) => string): string {
  if (['in_progress', 'running', 'pending', 'queued'].includes(status)) return t('resultInProgress');
  if (status === 'success' || status === 'succeeded' || status === 'completed') return t('resultSucceeded');
  if (status === 'timeout' || status === 'timed_out') return t('resultTimeout');
  if (status === 'uncertain') return t('resultUncertain');
  if (status === 'unverified' || status === 'spawned' || status === 'admitted') return t('resultDispatched');
  if (status === 'cancelled' || status === 'canceled') return t('resultCancelled');
  if (status === 'none') return t('resultNone');
  if (status === 'failed') return t('resultFailed');
  return status;
}

function ResultRow({ item, projectName, onSelect, onOpenSession, onRetry }: {
  item: AutomationResultItem;
  projectName: string;
  onSelect: (item: AutomationResultItem) => void;
  onOpenSession: (sessionId: string) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation('schedule');
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [receiptError, setReceiptError] = useState(false);
  async function acknowledge(action: 'read' | 'actioned') {
    if (receiptBusy || !item.projectId) return;
    setReceiptBusy(true); setReceiptError(false);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/automations/results/${encodeURIComponent(item.run.id)}/receipt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ projectId: item.projectId, action }),
      });
      if (!response.ok) throw new Error('receipt update failed');
      onRetry();
    } catch { setReceiptError(true); }
    finally { setReceiptBusy(false); }
  }
  const status = resultStatus(item);
  const isAttention = resultNeedsAttention(item);
  const text = item.run.summaryText?.trim();
  return <article className="rounded-xl border border-surface-800 bg-surface-850/55 p-3" data-testid={`automation-result-${item.run.id}`}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <button type="button" onClick={() => onSelect(item)} className="min-w-0 flex-1 text-left hover:text-primary-300">
        <span className="block truncate text-[14px] font-semibold text-surface-100">{item.automationName}</span>
        <span className="mt-1 block text-[12px] text-surface-400">{projectName} · {new Date(item.run.ranAt).toLocaleString()}{item.run.durationMs != null ? ` · ${(item.run.durationMs / 1000).toFixed(1)}s` : ''}</span>
      </button>
      <span className={`rounded px-2 py-1 text-[12px] font-semibold ${isAttention ? 'tone-danger tone-text bg-red-500/10' : status === 'in_progress' || status === 'running' || status === 'pending' || status === 'queued' ? 'text-blue-200 bg-blue-500/15' : ['success', 'succeeded', 'completed'].includes(status) ? 'text-emerald-200 bg-emerald-500/10' : 'text-surface-300 bg-surface-800'}`}>{resultStatusLabel(status, t)}</span>
    </div>
    {text && <p className={`mt-2 whitespace-pre-wrap break-words text-[13px] leading-5 ${isAttention ? 'text-red-200' : 'text-surface-300'}`}>{text}</p>}
    {item.run.error && <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-5 text-red-200">{item.run.error}</p>}
    <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px]">
      <button type="button" onClick={() => onSelect(item)} className="text-primary-300 hover:underline">{t('resultViewDetails')}</button>
      {item.sessionId ? <button type="button" onClick={() => onOpenSession(item.sessionId!)} className="text-primary-300 hover:underline">{t('resultOpenSession')}</button> : <span className="text-surface-500">{t('resultNoSession')}</span>}
      {item.receipt && <>
        <span className="text-surface-400">{item.receipt.actionedAt ? t('resultActioned') : item.receipt.readAt ? t('resultRead') : t('resultUnread')}</span>
        {!item.receipt.readAt && <button type="button" disabled={receiptBusy} onClick={() => void acknowledge('read')} className="text-primary-300 hover:underline disabled:opacity-50">{t('resultMarkRead')}</button>}
        {!item.receipt.actionedAt && <button type="button" disabled={receiptBusy} onClick={() => void acknowledge('actioned')} className="text-primary-300 hover:underline disabled:opacity-50">{t('resultMarkActioned')}</button>}
      </>}
    </div>
    {receiptError && <p role="alert" className="mt-2 text-[12px] text-red-200">{t('resultReceiptFailed')}</p>}
  </article>;
}

export function AutomationResultsPanel({ items, loading, error, projectRequired = false, onRetry, projectById, onSelect, onOpenSession, compact = false }: {
  items: AutomationResultItem[];
  loading: boolean;
  error: string | null;
  projectRequired?: boolean;
  onRetry: () => void;
  projectById: Map<string, { name: string }>;
  onSelect: (item: AutomationResultItem) => void;
  onOpenSession: (sessionId: string) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation('schedule');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const shown = items.filter(item => (!attentionOnly || resultNeedsAttention(item)) && (!unreadOnly || (item.receipt && !item.receipt.readAt))).slice(0, compact ? 1 : undefined);
  return <div className="space-y-3" data-testid={compact ? 'automation-latest-result' : 'automation-results'}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-[13px] font-bold text-surface-200">{compact ? t('latestResult') : t('resultsTitle')}</h2>
      {!compact && <button type="button" aria-pressed={attentionOnly} onClick={() => setAttentionOnly((value) => !value)} className={`rounded-lg border px-2.5 py-1 text-[12px] font-semibold ${attentionOnly ? 'border-red-400/40 bg-red-500/10 text-red-200' : 'border-surface-700 text-surface-300 hover:bg-surface-800'}`}>{t('resultAttentionOnly')}</button>}
    </div>
    {!compact && items.some(item => item.receipt) && <>
      <p className="text-[12px] text-surface-400">{t('resultReceiptHint')}</p>
      <button type="button" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(value => !value)} className="text-left text-[12px] text-primary-300 hover:underline">{t('resultUnreadOnly')}</button>
    </>}
    {projectRequired ? <p className="text-[13px] text-surface-500">{t('resultsSelectProject')}</p> : loading && items.length === 0 ? <p role="status" className="text-[13px] text-surface-400">{t('resultsLoading')}</p> : error ? <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[13px] text-red-200">{t('resultsLoadFailed')}: {error} <button type="button" onClick={onRetry} className="ml-2 underline">{t('resultsRetry')}</button></div> : shown.length === 0 ? <p className="text-[13px] text-surface-500">{unreadOnly ? t('resultsNoUnread') : attentionOnly ? t('resultsNoAttention') : t('resultsEmpty')}</p> : shown.map((item) => <ResultRow key={item.run.id} item={item} projectName={item.projectId ? projectById.get(item.projectId)?.name || t('noProject') : t('systemJobs')} onSelect={onSelect} onOpenSession={onOpenSession} onRetry={onRetry} />)}
  </div>;
}
