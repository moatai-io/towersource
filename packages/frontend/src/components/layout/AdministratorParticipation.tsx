import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCurrentRole, getCurrentUserId } from '../../utils/auth';

type Participant = { userId: number; username: string };
const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('token') || ''}`, 'Content-Type': 'application/json' });

/** Only an actual Workspace entry may opt into project auto-participation.
 * Keep this mounted for that entry (including searches/sidebar visibility changes).
 * Directory/profile previews must not pass workspaceEntered; channels remain explicit.
 */
export function AdministratorParticipation({ targetId, scope = 'project', workspaceEntered = false }: {
  targetId: string;
  scope?: 'project' | 'channel';
  workspaceEntered?: boolean;
}) {
  const { t } = useTranslation('layout');
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const userId = getCurrentUserId();
  const operator = getCurrentRole() === 'operator';
  const endpoint = `/api/administrator-participation/${scope}/${encodeURIComponent(targetId)}`;
  const enabled = operator && (scope === 'channel' || workspaceEntered);
  const announce = () => window.dispatchEvent(new CustomEvent('tower-administrator-participation-changed', { detail: { scope, targetId } }));

  async function readParticipants(): Promise<Participant[]> {
    const response = await fetch(endpoint, { headers: headers() });
    if (!response.ok) throw new Error('unavailable');
    return (await response.json()).participants || [];
  }

  useEffect(() => {
    const current = ++generation.current;
    const active = () => current === generation.current;
    setParticipants([]); setError(false); setBusy(enabled);
    if (enabled) void (async () => {
      try {
        let next = await readParticipants();
        if (!active()) return;
        if (scope === 'project' && !next.some(p => p.userId === userId)) {
          const response = await fetch(endpoint, { method: 'POST', headers: headers(), body: JSON.stringify({ confirmed: true }) });
          if (!response.ok) throw new Error('unavailable');
          // The server serializes and deduplicates simultaneous entries/refreshes.
          if (!active()) return;
          announce();
          next = await readParticipants();
        }
        if (active()) setParticipants(next);
      } catch { if (active()) setError(true); }
      finally { if (active()) setBusy(false); }
    })();
    return () => { ++generation.current; };
    // Participation changes are deliberately not dependencies: leaving must not rejoin.
  }, [endpoint, enabled, scope, userId]);

  const joined = participants.some(p => p.userId === userId);
  async function change() {
    if (busy) return;
    const current = generation.current;
    const active = () => current === generation.current;
    setBusy(true); setError(false);
    try {
      const response = await fetch(endpoint, { method: joined ? 'DELETE' : 'POST', headers: headers(), body: JSON.stringify({ confirmed: true }) });
      if (!response.ok) throw new Error('unavailable');
      if (!active()) return;
      announce();
      // Reflect persisted leave even if the subsequent list refresh fails.
      if (joined) setParticipants(previous => previous.filter(p => p.userId !== userId));
      const next = await readParticipants();
      if (active()) setParticipants(next);
    } catch { if (active()) setError(true); }
    finally { if (active()) setBusy(false); }
  }
  if (!enabled || (!joined && !busy && !error && scope === 'project')) return null;
  return <section className="mx-3 my-2 rounded-md border border-surface-700 px-3 py-2 text-xs text-surface-400" aria-label={t('administratorParticipation.title')}>
    {(joined || scope === 'channel') && <button type="button" disabled={busy} onClick={() => void change()} className="mt-2 rounded border border-surface-600 px-2 py-1 text-surface-200 disabled:opacity-50">{t(joined ? 'administratorParticipation.leave' : 'administratorParticipation.join')}</button>}
    {busy && scope === 'project' && !joined && <p role="status">{t('administratorParticipation.entering')}</p>}
    {error && <p role="alert" className="mt-1">{t('administratorParticipation.error')}</p>}
  </section>;
}
