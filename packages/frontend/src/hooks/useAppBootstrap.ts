import { towerHttpUrl } from '../features/client-connection/connection';
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useGitStore } from '../stores/git-store';
import { reconcileSelectedModel, useModelStore } from '../stores/model-store';
import { usePinStore } from '../stores/pin-store';
import { usePromptStore } from '../stores/prompt-store';
import { useSessionStore } from '../stores/session-store';
import { useSettingsStore } from '../stores/settings-store';
import { clearReloadOnceFlag } from '../utils/app-version';
import type { UpdateCoordinator } from './useAppUpdateCoordinator';

import { clearCredentialIfCurrent, isCurrentCredential } from '../utils/account-transition';

const AUTH_401_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;
const BRANDING_CACHE_BUSTER = Date.now().toString(36);
const CUSTOM_APP_BACKGROUND_SRC = towerHttpUrl(`/api/branding/app-background?v=${BRANDING_CACHE_BUSTER}`);

export interface AuthStatus {
  authEnabled: boolean;
  hasUsers: boolean;
}

function readCachedAuthStatus(): AuthStatus | null {
  try {
    const cached = localStorage.getItem('tower:authCache');
    return cached ? JSON.parse(cached) : null;
  } catch {
    return null;
  }
}

async function fetchWithRestartTolerantAuth(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let response = await fetch(input, init);
  for (const delayMs of AUTH_401_RETRY_DELAYS_MS) {
    if (response.status !== 401) return response;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    response = await fetch(input, { ...init, cache: 'no-store' });
  }
  return response;
}

export function useAuthBootstrap(token: string | null, setToken: Dispatch<SetStateAction<string | null>>) {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(readCachedAuthStatus);

  useEffect(() => {
    fetch(towerHttpUrl(`/api/auth/status`))
      .then((response) => {
        if (response.status === 429) return { authEnabled: true, hasUsers: true };
        return response.json();
      })
      .then(async (status: AuthStatus) => {
        try { localStorage.setItem('tower:authCache', JSON.stringify(status)); } catch {}
        if (status.authEnabled && token) {
          try {
            const response = await fetchWithRestartTolerantAuth(towerHttpUrl(`/api/auth/check`), {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (response.status === 401 && clearCredentialIfCurrent(token)) {
              setToken(null);
            }
          } catch {
            // Keep the token during connectivity failures.
          }
        }
        setAuthStatus((previous) => previous
          && previous.authEnabled === status.authEnabled
          && previous.hasUsers === status.hasUsers
          ? previous
          : status);
      })
      .catch(() => setAuthStatus((previous) => previous ?? { authEnabled: false, hasUsers: false }));
  }, []); // Authentication is verified once per page boot; token changes are handled by login/logout.

  return { authStatus, setAuthStatus };
}

export function useBrandingBootstrap() {
  const [appBackgroundSrc, setAppBackgroundSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(towerHttpUrl('/api/branding/status'), { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((status) => {
        if (!cancelled && status?.appBackgroundConfigured) setAppBackgroundSrc(CUSTOM_APP_BACKGROUND_SRC);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return { appBackgroundSrc, clearAppBackground: () => setAppBackgroundSrc(null) };
}

interface AppDataBootstrapOptions {
  authStatus: AuthStatus | null;
  token: string | null;
  activeSessionId: string | null;
  firstRunInferenceSetup: boolean;
  setFirstRunInferenceSetup: Dispatch<SetStateAction<boolean>>;
  setFirstRunInferenceSetupResolved: Dispatch<SetStateAction<boolean>>;
  updateCoordinator: UpdateCoordinator;
}

export function useAppDataBootstrap({
  authStatus,
  token,
  activeSessionId,
  firstRunInferenceSetup,
  setFirstRunInferenceSetup,
  setFirstRunInferenceSetupResolved,
  updateCoordinator,
}: AppDataBootstrapOptions) {
  useEffect(() => {
    if (authStatus === null || (authStatus.authEnabled && !token)) return;
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

    fetch(towerHttpUrl(`/api/pins`), { headers })
      .then((response) => response.ok ? response.json() : [])
      .then((data) => { if (isCurrentCredential(token)) usePinStore.getState().setPins(data); })
      .catch(() => {});

    fetch(towerHttpUrl(`/api/git/log?limit=50`), { headers })
      .then((response) => response.ok ? response.json() : [])
      .then((data) => { if (isCurrentCredential(token)) useGitStore.getState().setCommits(data); })
      .catch(() => {});

    fetch(towerHttpUrl(`/api/config`), { headers })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (!data || !isCurrentCredential(token)) return;
        updateCoordinator.evaluateConfigPayload(data);
        useSettingsStore.getState().setServerConfig(data);
        if (data.models) useModelStore.getState().setAvailableModels(data.models);
        if (data.piModels) useModelStore.getState().setPiModels(data.piModels);
        if (data.localModels) useModelStore.getState().setLocalModels(data.localModels);
        if (data.connectionType) useModelStore.getState().setConnectionType(data.connectionType);
        if (data.defaults) useModelStore.getState().setDefaults(data.defaults);
        if (firstRunInferenceSetup && data.inferenceReadiness?.status === 'ready') {
          localStorage.removeItem('tower:firstRunInferenceSetup');
          setFirstRunInferenceSetup(false);
        }
        setFirstRunInferenceSetupResolved(true);
        reconcileSelectedModel();
      })
      .catch(() => setFirstRunInferenceSetupResolved(true));
  }, [authStatus, firstRunInferenceSetup, setFirstRunInferenceSetup, setFirstRunInferenceSetupResolved, token, updateCoordinator]);

  useEffect(() => {
    if (authStatus === null || (authStatus.authEnabled && !token)) return;
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const promptParams = new URLSearchParams();
    const activeSession = useSessionStore.getState().sessions.find((session) => session.id === activeSessionId);
    if (activeSession?.projectId) promptParams.set('projectId', activeSession.projectId);
    if (activeSession?.cwd) promptParams.set('cwd', activeSession.cwd);

    fetch(towerHttpUrl(`/api/prompts${promptParams.toString() ? `?${promptParams.toString()}` : ''}`), { headers })
      .then((response) => response.ok ? response.json() : [])
      .then((data) => usePromptStore.getState().setPrompts(data))
      .catch(() => {});
  }, [activeSessionId, authStatus, token]);

  useEffect(() => {
    clearReloadOnceFlag();
  }, []);
}
