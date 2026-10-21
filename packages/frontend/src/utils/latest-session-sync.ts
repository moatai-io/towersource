import { useSessionStore } from '../stores/session-store';

let pending: Promise<void> | null = null;

/** Recover sidebar snapshots missed while another device or a suspended tab changed them. */
export function refreshLatestSessionSnapshot(): Promise<void> {
  if (pending) return pending;
  const requestedAt = Date.now();
  pending = Promise.allSettled([
    fetch('/api/sessions', { headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` } }).then(response => {
      if (!response.ok) throw new Error('Session snapshot unavailable');
      return response.json();
    }).then(sessions => {
      if (Array.isArray(sessions)) {
        useSessionStore.getState().setRecentSessions(sessions.filter(session => !session.roomId), { requestedAt });
      }
    }),
    useSessionStore.getState().hydrateLatestAttentionFromServer(),
  ]).then(() => undefined).finally(() => { pending = null; });
  return pending;
}
