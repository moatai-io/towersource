import { useEffect } from 'react';
import { useFileStore } from '../stores/file-store';
import { useSessionStore, type SessionMeta } from '../stores/session-store';
import { findSessionByKey } from './useUrlSync';

const API_BASE = '/api';

interface UseSessionEventNavigationOptions {
  onSelectSession: (session: SessionMeta) => Promise<void>;
}

export function useSessionEventNavigation({ onSelectSession }: UseSessionEventNavigationOptions) {
  useEffect(() => {
    const handleNavigation = async (event: Event) => {
      const { sessionId, sessionKey, forceNew, hash } = (event as CustomEvent).detail ?? {};
      const key = sessionKey || sessionId;
      if (!key) return;

      let session = sessionKey
        ? findSessionByKey(useSessionStore.getState().sessions, sessionKey)
        : useSessionStore.getState().sessions.find((candidate) => candidate.id === sessionId);
      if (!session) {
        try {
          const headers: Record<string, string> = {};
          const token = localStorage.getItem('token');
          if (token) headers.Authorization = `Bearer ${token}`;
          const response = await fetch(`${API_BASE}/sessions/${key}`, { headers });
          if (response.ok) {
            session = await response.json();
            if (session) useSessionStore.getState().addSession(session);
          }
        } catch {
          // The originating surface remains open when navigation cannot resolve.
        }
      }
      if (!session) return;

      if (forceNew) useFileStore.getState().openChatTab(session.id, { forceNew: true });
      await onSelectSession(session);
      if (typeof hash === 'string' && hash.startsWith('#')) {
        const targetPath = `/s/${session.shortCode || session.id}`;
        window.history.replaceState(null, '', `${targetPath}${hash}`);
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
    };

    const handlePushNavigation = (event: MessageEvent) => {
      if (event.data?.type !== 'tower-open-session' || typeof event.data.sessionKey !== 'string') return;
      void handleNavigation(new CustomEvent('kanban-select-session', {
        detail: { sessionKey: event.data.sessionKey },
      }));
    };
    navigator.serviceWorker?.addEventListener('message', handlePushNavigation);
    window.addEventListener('kanban-select-session', handleNavigation);
    return () => {
      window.removeEventListener('kanban-select-session', handleNavigation);
      navigator.serviceWorker?.removeEventListener('message', handlePushNavigation);
    };
  }, [onSelectSession]);
}
