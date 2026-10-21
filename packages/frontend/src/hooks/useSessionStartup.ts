import { useEffect, useRef, useState } from 'react';
import { decideAgentFirstStartup } from '../agent-first-startup';
import { useChatStore } from '../stores/chat-store';
import { useFileStore } from '../stores/file-store';
import { useProjectStore } from '../stores/project-store';
import { useRoomStore } from '../stores/room-store';
import { useSessionStore, type SessionMeta } from '../stores/session-store';
import { useSettingsStore } from '../stores/settings-store';
import { useSpaceStore } from '../stores/space-store';
import { logClientPerf, perfNow } from '../utils/client-perf';
import { getTokenUserId, lastViewedKey } from '../utils/session-restore';
import type { AuthStatus } from './useAppBootstrap';
import { parseUrl } from './useUrlSync';
import { lookupSessionLink, type SessionLinkState } from './session-link-resolution';

const API_BASE = '/api';
const STARTUP_SESSION_LIST_LIMIT = 200;
const AUTH_401_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

async function fetchWithRestartTolerantAuth(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let response = await fetch(input, init);
  for (const delayMs of AUTH_401_RETRY_DELAYS_MS) {
    if (response.status !== 401) return response;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    response = await fetch(input, { ...init, cache: 'no-store' });
  }
  return response;
}

interface UseSessionStartupOptions {
  token: string | null;
  setToken: (token: string | null) => void;
  authStatus: AuthStatus | null;
  onSelectSession: (session: SessionMeta) => Promise<void>;
  onSessionListLoaded?: () => void;
}

export function useSessionStartup({ token, setToken, authStatus, onSelectSession, onSessionListLoaded }: UseSessionStartupOptions) {
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionLinkState, setSessionLinkState] = useState<SessionLinkState | null>(() =>
    window.location.pathname.startsWith('/s/') ? { kind: 'loading' } : null,
  );
  const startupSessionsLoadRef = useRef<{ key: string | null; inFlight: boolean }>({ key: null, inFlight: false });

  useEffect(() => {
    if (authStatus === null || (authStatus.authEnabled && !token)) return;

    const startupKey = `${authStatus.authEnabled ? 'auth' : 'public'}:${token ?? 'anon'}`;
    if (sessionsLoaded && startupSessionsLoadRef.current.key === startupKey) return;
    if (startupSessionsLoadRef.current.inFlight && startupSessionsLoadRef.current.key === startupKey) return;
    startupSessionsLoadRef.current = { key: startupKey, inFlight: true };

    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const projectsPromise = fetch(`${API_BASE}/projects`, { headers })
      .then((response) => response.ok ? response.json() : [])
      .then((data) => {
        const projects = Array.isArray(data) ? data : [];
        useProjectStore.getState().setProjects(projects);
        return projects;
      })
      .catch(() => []);
    const requestedAt = Date.now();
    const startedAt = perfNow();

    fetchWithRestartTolerantAuth(`${API_BASE}/sessions?limit=${STARTUP_SESSION_LIST_LIMIT}`, { headers })
      .then(async (response) => {
        const responseMs = Math.round(perfNow() - startedAt);
        if (response.status === 401) {
          localStorage.removeItem('token');
          setToken(null);
          return [];
        }
        if (!response.ok) {
          logClientPerf('startup-sessions-fetch', { status: response.status, responseMs, elapsedMs: responseMs }, { thresholdMs: 500 });
          return [];
        }
        const parseStartedAt = perfNow();
        const data = await response.json();
        logClientPerf('startup-sessions-fetch', {
          status: response.status,
          sessionCount: Array.isArray(data) ? data.length : 0,
          requestedLimit: STARTUP_SESSION_LIST_LIMIT,
          responseMs,
          parseMs: Math.round(perfNow() - parseStartedAt),
          elapsedMs: Math.round(perfNow() - startedAt),
        }, { thresholdMs: 500 });
        return data;
      })
      .then(async (data: SessionMeta[]) => {
        const setStartedAt = perfNow();
        useSessionStore.getState().resetProjectSessionHydration();
        useSessionStore.getState().setRecentSessions(data, { requestedAt });
        onSessionListLoaded?.();
        setSessionsLoaded(true);
        logClientPerf('startup-sessions-store-set', {
          sessionCount: Array.isArray(data) ? data.length : 0,
          requestedLimit: STARTUP_SESSION_LIST_LIMIT,
          setStateMs: Math.round(perfNow() - setStartedAt),
          elapsedMs: Math.round(perfNow() - startedAt),
        }, { thresholdMs: 500 });

        const initialUrl = parseUrl(window.location.pathname, window.location.search);
        if (initialUrl.view) useSessionStore.getState().setActiveView(initialUrl.view);
        if (initialUrl.systemTab && !window.location.pathname.startsWith('/s/')) useFileStore.getState().openSystemTab(initialUrl.systemTab);

        const restoreLastViewedSession = async () => {
          const lastId = localStorage.getItem(lastViewedKey(getTokenUserId(token)));
          if (!lastId) return false;
          const lastSession = data.find((session) => session.id === lastId);
          if (lastSession) {
            await onSelectSession(lastSession);
            return true;
          }
          try {
            const response = await fetch(`${API_BASE}/sessions/${lastId}`, { headers });
            if (!response.ok) return false;
            const session = await response.json();
            useSessionStore.getState().addSession(session);
            await onSelectSession(session);
            return true;
          } catch {
            return false;
          }
        };

        if (initialUrl.roomKey) {
          useRoomStore.getState().setActiveRoomId(null);
          useFileStore.getState().activateChatSlot();
          useSessionStore.getState().setActiveView('rooms');
          useSessionStore.getState().setSidebarOpen(false);
          return;
        }

        if (window.location.pathname.startsWith('/s/')) {
          const requestedPath = window.location.pathname;
          const result = initialUrl.sessionKey
            ? await lookupSessionLink(initialUrl.sessionKey, headers)
            : { kind: 'not_found' as const };
          if (window.location.pathname !== requestedPath) return;
          if (result.kind === 'session') {
            await onSelectSession(result.session);
            setSessionLinkState(null);
            if (initialUrl.systemTab) useFileStore.getState().openSystemTab(initialUrl.systemTab);
          } else {
            useSessionStore.getState().setActiveSessionId(null);
            const chat = useChatStore.getState();
            chat.setSessionId(null);
            chat.setEngineSessionId(null);
            chat.clearMessages();
            chat.setSessionLoading(false);
            setSessionLinkState(result);
          }
          return;
        }

        if (await restoreLastViewedSession()) return;
        const projects = await projectsPromise;
        const decision = decideAgentFirstStartup({
          agentFirstEnabled: useSettingsStore.getState().serverConfig?.agentFirstEnabled === true,
          sessions: data,
          projects,
        });
        if (decision.kind === 'open-agent-creator') {
          window.setTimeout(() => window.dispatchEvent(new CustomEvent('tower-start-agent-academy')), 0);
        }
      })
      .catch(() => {
        setSessionsLoaded(true);
        if (window.location.pathname.startsWith('/s/')) setSessionLinkState({ kind: 'unavailable' });
      })
      .finally(() => {
        if (startupSessionsLoadRef.current.key === startupKey) startupSessionsLoadRef.current.inFlight = false;
      });

    fetch(`${API_BASE}/spaces`, { headers })
      .then((response) => response.ok ? response.json() : [])
      .then((data) => { if (Array.isArray(data)) useSpaceStore.getState().setSpaces(data); })
      .catch(() => {});
  }, [authStatus, onSelectSession, onSessionListLoaded, sessionsLoaded, setToken, token]);

  return { sessionsLoaded, sessionLinkState, setSessionLinkState };
}
