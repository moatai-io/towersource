import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type CheckpointChange = { filePath: string; beforeExists: boolean; afterExists: boolean };
type PreviewItem = { filePath: string; action: 'create' | 'update' | 'delete' | 'noop'; status: 'ready' | 'conflict' };
type Checkpoint = { id: string; coverage: 'tool_edits' | 'partial'; changes: CheckpointChange[] };
type Preview = { previewHash: string; items: PreviewItem[]; canApply: boolean; coverage: 'tool_edits' | 'partial' };
type UiState = 'closed' | 'loading' | 'ready' | 'previewing' | 'applying' | 'applied' | 'empty' | 'error';

function authHeaders(json = false): Record<string, string> {
  const token = localStorage.getItem('token');
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
function fileName(filePath: string) { return filePath.split('/').filter(Boolean).pop() || filePath; }


export function TurnCheckpointCard({ sessionId, turnId }: { sessionId: string; turnId: string }) {
  const { t } = useTranslation('chat');
  const actionLabel = (action: PreviewItem['action']) => t(`checkpoint.action.${action}`);
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState(false);
  const [state, setState] = useState<UiState>('closed');
  const [error, setError] = useState('');
  const selectedPaths = useMemo(() => [...selected], [selected]);

  async function requestPreview(next: Checkpoint, paths: string[]) {
    setState('previewing'); setError(''); setConfirmed(false);
    const response = await fetch(`/api/checkpoints/${encodeURIComponent(next.id)}/restore-preview`, {
      method: 'POST', headers: authHeaders(true), body: JSON.stringify({ paths }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || t('checkpoint.previewFailed'));
    setPreview(body as Preview); setState('ready');
  }

  async function openCheckpoint() {
    setState('loading'); setError('');
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/checkpoint`, { headers: authHeaders() });
      if (response.status === 404) { setState('empty'); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || t('checkpoint.loadFailed'));
      const next = body as Checkpoint;
      const paths = next.changes.map((change) => change.filePath);
      setCheckpoint(next); setSelected(new Set(paths));
      await requestPreview(next, paths);
    } catch (err) { setError(err instanceof Error ? err.message : t('checkpoint.loadFailed')); setState('error'); }
  }

  async function refreshPreview(paths = selectedPaths) {
    if (!checkpoint || paths.length === 0) return;
    try { await requestPreview(checkpoint, paths); }
    catch (err) { setError(err instanceof Error ? err.message : t('checkpoint.refreshFailed')); setState('error'); }
  }

  async function applyRestore() {
    if (!checkpoint || !preview || !confirmed || selectedPaths.length === 0) return;
    setState('applying'); setError('');
    try {
      const response = await fetch(`/api/checkpoints/${encodeURIComponent(checkpoint.id)}/restore`, {
        method: 'POST', headers: authHeaders(true),
        body: JSON.stringify({ confirmed: true, previewHash: preview.previewHash, paths: selectedPaths }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || t('checkpoint.restoreFailed'));
      setState('applied'); setConfirmed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('checkpoint.restoreFailed'));
      setConfirmed(false); setState('error');
    }
  }

  if (state === 'closed') return (
    <button type="button" onClick={() => void openCheckpoint()} className="mt-2 min-h-10 rounded-lg border border-surface-700 px-3 text-[13px] font-medium text-surface-500 transition-colors hover:border-primary-500 hover:text-primary-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500" aria-label={t('checkpoint.checkChangesLabel')}>
      {t('checkpoint.checkChanges')}
    </button>
  );
  if (state === 'empty') return <div className="mt-2 text-[13px] text-surface-500">{t('checkpoint.noChanges')}</div>;
  if (state === 'loading' || state === 'previewing') return <div className="mt-2 min-h-10 text-[13px] text-surface-500" role="status">{state === 'loading' ? t('checkpoint.loading') : t('checkpoint.previewing')}</div>;

  const hasConflict = !!preview?.items.some((item) => item.status === 'conflict');
  return (
    <section className="tone-muted tone-card mt-2 w-full max-w-xl rounded-xl p-3 text-left" aria-label={t('checkpoint.restoreLabel')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-[14px] font-semibold text-surface-200">{t('checkpoint.title')}</h4>
          <p className="mt-1 text-[13px] leading-5 text-surface-500">{t('checkpoint.description')}</p>
        </div>
        <button type="button" onClick={() => { setState('closed'); setError(''); }} className="min-h-10 rounded-lg px-3 text-[13px] text-surface-500 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">{t('checkpoint.close')}</button>
      </div>

      {checkpoint?.coverage === 'partial' && <div className="tone-warning tone-card mt-3 rounded-lg p-2.5 text-[13px] leading-5"><strong className="tone-text">{t('checkpoint.partialTitle')}</strong><span className="text-surface-400">{t('checkpoint.partialDescription')}</span></div>}
      {error && <div className="tone-danger tone-card mt-3 rounded-lg p-2.5 text-[13px]" role="alert">{error} <button type="button" className="ml-2 underline underline-offset-2" onClick={() => void refreshPreview()}>{t('checkpoint.checkAgain')}</button></div>}
      {state === 'applied' && <div className="tone-success tone-card mt-3 rounded-lg p-2.5 text-[13px]" role="status">{t('checkpoint.restored')}</div>}

      {preview && state !== 'applied' && <div className="mt-3 space-y-2">
        {preview.items.map((item) => {
          const checked = selected.has(item.filePath);
          return <label key={item.filePath} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 focus-within:ring-2 focus-within:ring-primary-500">
            <input type="checkbox" checked={checked} onChange={() => {
              const next = new Set(selected); checked ? next.delete(item.filePath) : next.add(item.filePath); setSelected(next); setPreview(null); setConfirmed(false);
            }} className="h-4 w-4 accent-primary-500" />
            <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-surface-200" title={item.filePath}>{fileName(item.filePath)}</span><span className="block truncate text-[12px] text-surface-500" title={item.filePath}>{item.filePath}</span></span>
            <span className={`tone-pill text-[12px] ${item.status === 'conflict' ? 'tone-warning' : 'tone-muted'}`}>{item.status === 'conflict' ? t('checkpoint.conflict') : actionLabel(item.action)}</span>
          </label>;
        })}
      </div>}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {!preview && <button type="button" disabled={selectedPaths.length === 0} onClick={() => void refreshPreview()} className="tone-accent tone-action min-h-10 rounded-lg px-3 text-[13px] font-semibold disabled:cursor-not-allowed disabled:border-surface-700 disabled:bg-surface-900 disabled:text-surface-600">{t('checkpoint.checkSelection')}</button>}
        {preview && <button type="button" onClick={() => void refreshPreview()} className="min-h-10 rounded-lg border border-surface-700 px-3 text-[13px] text-surface-400 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">{t('checkpoint.checkAgain')}</button>}
      </div>

      {preview && !hasConflict && state !== 'applied' && <div className="mt-3 border-t border-surface-700 pt-3">
        <label className="flex min-h-11 cursor-pointer items-start gap-3 text-[13px] leading-5 text-surface-300"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1 h-4 w-4 accent-primary-500" /><span>{t('checkpoint.confirmReplacement')}</span></label>
        <button type="button" disabled={!confirmed || state === 'applying'} onClick={() => void applyRestore()} className="tone-danger tone-action mt-2 min-h-11 w-full rounded-lg px-4 text-[14px] font-semibold disabled:cursor-not-allowed disabled:border-surface-700 disabled:bg-surface-900 disabled:text-surface-600">{state === 'applying' ? t('checkpoint.restoring') : t('checkpoint.restoreSelected', { count: selectedPaths.length })}</button>
      </div>}
      {preview && hasConflict && <p className="tone-warning tone-text mt-3 text-[13px] leading-5">{t('checkpoint.conflictWarning')}</p>}
    </section>
  );
}
