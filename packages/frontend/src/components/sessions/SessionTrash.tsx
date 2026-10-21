import { towerHttpUrl, readBrowserAuthToken } from '../../features/client-connection/connection';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore, type SessionMeta } from '../../stores/session-store';

const headers = () => ({ Authorization: `Bearer ${readBrowserAuthToken() || ''}` });

/** Mounted on demand: an empty query still lists all of the user's archive. */
export function SessionTrash({ onClose, onSelectSession }: { onClose: () => void; onSelectSession?: (session: SessionMeta) => void }) {
  const { t } = useTranslation('layout');
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreLock = useRef(false);
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(false);
    fetch(towerHttpUrl(`/api/sessions/archived`), { headers: headers(), signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('archive');
        const data = await response.json();
        if (!Array.isArray(data)) throw new Error('archive');
        if (!controller.signal.aborted) setSessions(data);
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);
  async function restore(id: string) {
    if (restoreLock.current) return;
    restoreLock.current = true; setBusy(id); setError(false);
    try {
      const response = await fetch(towerHttpUrl(`/api/sessions/${encodeURIComponent(id)}/restore`), { method: 'POST', headers: headers() });
      if (!response.ok) throw new Error('restore');
      const data = await response.json();
      if (!data.session?.id) throw new Error('restore');
      useSessionStore.getState().mergeSessions([data.session]);
      setSessions(current => current.filter(session => session.id !== id));
      window.dispatchEvent(new CustomEvent('tower-session-archive-changed'));
    } catch { setError(true); }
    finally { restoreLock.current = false; setBusy(null); }
  }
  return (
    <section aria-label={t('archivedSessionsTitle')} className="absolute left-0 top-full mt-2 w-[min(24rem,calc(100vw-2rem))] max-h-[calc(100dvh-5rem)] overflow-y-auto bg-surface-900 border border-surface-700 rounded-xl shadow-xl z-[100] p-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">{t('archivedSessionsTitle')}</h2>
        <button ref={closeRef} onClick={onClose} className="px-3 py-2 rounded hover:bg-surface-800">{t('common:close')}</button>
      </div>
      <p className="text-sm text-surface-400 my-2">{t('sessionTrashDescription')}</p>
      {loading && <p role="status">{t('common:loading')}</p>}
      {error && <div role="alert"><p>{t('sessionTrashFailed')}</p><button onClick={() => setAttempt(value => value + 1)} className="px-3 py-2">{t('sessionTrashRetry')}</button></div>}
      {!loading && !error && sessions.length === 0 && <p>{t('sessionTrashEmpty')}</p>}
      <ul className="divide-y divide-surface-700">
        {sessions.map(session => <li key={session.id} className="py-3 flex items-center gap-3">
          <div className="min-w-0 flex-1"><button type="button" disabled={!onSelectSession} onClick={() => onSelectSession?.(session)} className="text-left break-words underline disabled:opacity-40" aria-label={`${session.name} · ${t('sessionArchiveOpen')}`}>{session.name}</button>
            {session.agent?.workerId && <p className="text-xs text-surface-400">{t('sessionTrashWorker')}</p>}
          </div>
          <button disabled={busy !== null || !!session.agent?.workerId} onClick={() => void restore(session.id)} className="px-3 py-2 rounded hover:bg-surface-800 disabled:opacity-40">{busy === session.id ? t('common:loading') : t('sessionTrashRestore')}</button>
        </li>)}
      </ul>
    </section>
  );
}
