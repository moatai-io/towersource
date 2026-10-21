import { useEffect, useState } from 'react';
import type { SessionMeta } from '../../../stores/session-store';

export type SidebarSessionMeta = SessionMeta;
const EMPTY_ARCHIVED_SESSIONS: SidebarSessionMeta[] = [];

/** Local read-only archive snapshot; never hydrate archived rows into the live store. */
export function useSidebarArchivedSessions(enabled: boolean, liveSessionIds: string) {
  const [sessions, setSessions] = useState<SidebarSessionMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const refresh = () => setAttempt(value => value + 1);
    window.addEventListener('tower-session-archive-changed', refresh);
    return () => window.removeEventListener('tower-session-archive-changed', refresh);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setSessions([]);
      setLoading(false);
      setError(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    fetch('/api/sessions/archived', { headers, signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('archive');
        const data = await response.json();
        if (!Array.isArray(data)) throw new Error('archive');
        if (!controller.signal.aborted) setSessions(data.map(session => ({ ...session, archived: true })));
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [enabled, liveSessionIds, attempt]);

  return { sessions: enabled ? sessions : EMPTY_ARCHIVED_SESSIONS, loading: enabled && loading, error: enabled && error, retry: () => setAttempt(value => value + 1) };
}

/** Restored/live rows win duplicate ids. Disabled means archived rows cannot leak back. */
export function combineSidebarSessions(live: SidebarSessionMeta[], archived: SidebarSessionMeta[], enabled: boolean): SidebarSessionMeta[] {
  const byId = new Map<string, SidebarSessionMeta>();
  if (enabled) for (const session of archived) byId.set(session.id, session);
  for (const session of live) {
    if (enabled || !session.archived) byId.set(session.id, session);
  }
  return [...byId.values()];
}
