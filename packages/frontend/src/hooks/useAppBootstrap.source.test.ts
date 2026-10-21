import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('./useAppBootstrap.ts', import.meta.url), 'utf8');

describe('App bootstrap ownership', () => {
  it('keeps App on composition while hooks own auth and branding startup', () => {
    expect(app).toContain('useAuthBootstrap(token, setToken)');
    expect(app).toContain('useBrandingBootstrap()');
    expect(app).not.toContain("fetch(`${API_BASE}/auth/status`)");
    expect(app).not.toContain("fetch('/api/branding/status'");
    expect(bootstrap).toContain('export function useAuthBootstrap');
    expect(bootstrap).toContain('export function useBrandingBootstrap');
  });

  it('loads app-wide data independently from session-scoped prompts', () => {
    expect(app).toContain('useAppDataBootstrap({');
    expect(bootstrap).toContain("fetch(towerHttpUrl(`/api/pins`");
    expect(bootstrap).toContain("fetch(towerHttpUrl(`/api/prompts");
    expect(bootstrap).toContain("fetch(towerHttpUrl(`/api/git/log?limit=50`");
    expect(bootstrap).toContain("fetch(towerHttpUrl(`/api/config`");
    expect(bootstrap).toContain('reconcileSelectedModel()');
    expect(bootstrap).toContain('}, [authStatus, firstRunInferenceSetup, setFirstRunInferenceSetup, setFirstRunInferenceSetupResolved, token, updateCoordinator]);');
    expect(bootstrap).toContain('}, [activeSessionId, authStatus, token]);');
  });

  it('preserves restart-tolerant auth without using session listing as validation', () => {
    expect(bootstrap).toContain('AUTH_401_RETRY_DELAYS_MS');
    expect(bootstrap).toContain('fetchWithRestartTolerantAuth(towerHttpUrl(`/api/auth/check`)');
    expect(bootstrap).not.toContain('fetchWithRestartTolerantAuth(`${API_BASE}/sessions`');
  });
});
