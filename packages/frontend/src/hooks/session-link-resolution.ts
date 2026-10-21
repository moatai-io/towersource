import type { SessionMeta } from '../stores/session-store';
import { findSessionByKey } from './useUrlSync';

export type SessionLinkState = { kind: 'loading' | 'forbidden' | 'not_found' | 'authentication_required' | 'unavailable' | 'archived' };
type SessionLinkResult = { kind: 'session'; session: SessionMeta } | SessionLinkState;

/** Do not use cached metadata to bypass a link's current access/archive status. */
export async function lookupSessionLink(key: string, headers: Record<string, string>): Promise<SessionLinkResult> {
  try {
    const signal = AbortSignal.timeout(10_000);
    const response = await fetch(`/api/sessions/${encodeURIComponent(key)}`, { headers, signal });
    if (response.ok) {
      const session: SessionMeta = await response.json();
      return session.archived ? { kind: 'archived' } : { kind: 'session', session };
    }
    if (response.status === 403) return { kind: 'forbidden' };
    if (response.status === 401) return { kind: 'authentication_required' };
    if (response.status !== 404) return { kind: 'unavailable' };
    // The normal list omits archived rows. A 404 may also mean no permission,
    // so only identify an archive when the user's own archive list contains it.
    const archive = await fetch('/api/sessions/archived', { headers, signal });
    if (!archive.ok) return { kind: 'unavailable' };
    const archivedSessions = await archive.json();
    if (!Array.isArray(archivedSessions)) return { kind: 'unavailable' };
    return findSessionByKey(archivedSessions, key) ? { kind: 'archived' } : { kind: 'not_found' };
  } catch {
    return { kind: 'unavailable' };
  }
}
