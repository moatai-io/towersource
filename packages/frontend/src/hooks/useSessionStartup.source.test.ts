import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const startup = readFileSync(new URL('./useSessionStartup.ts', import.meta.url), 'utf8');

describe('session startup ownership', () => {
  it('keeps App on hook wiring while startup owns list loading and restoration', () => {
    expect(app).toContain('useSessionStartup({ token, setToken, authStatus');
    expect(app).not.toContain('// Load sessions when auth resolves');
    expect(startup).toContain('export function useSessionStartup');
    expect(startup).toContain('fetchWithRestartTolerantAuth(`${API_BASE}/sessions?limit=${STARTUP_SESSION_LIST_LIMIT}`');
  });

  it('restores explicit deep links before last-viewed and onboarding fallback', () => {
    const deepLink = startup.indexOf("if (window.location.pathname.startsWith('/s/'))");
    const lastViewed = startup.indexOf('if (await restoreLastViewedSession())');
    const onboarding = startup.indexOf('const decision = decideAgentFirstStartup');
    expect(deepLink).toBeGreaterThan(-1);
    expect(deepLink).toBeLessThan(lastViewed);
    expect(lastViewed).toBeLessThan(onboarding);
    expect(startup).toContain('await lookupSessionLink(initialUrl.sessionKey, headers)');
    expect(startup).toContain('setSessionLinkState(result)');
    expect(startup).toContain("{ kind: 'not_found' as const }");
  });

  it('covers restored desktop/mobile viewers with a persistent link notice', () => {
    expect(app.match(/sessionLinkSurface \?\? <AppContentRouter/g)).toHaveLength(2);
    expect(app).toContain('{!sessionLinkState && <ViewerPane');
    expect(app).toContain('isMobile && mobileContextOpen && !sessionLinkState');
    expect(startup).toContain("? { kind: 'loading' } : null");
    expect(app).toContain('sessionsLoaded, !!sessionLinkState');
  });

  it('hydrates projects and spaces without replacing project-specific session lists', () => {
    expect(startup).toContain("fetch(`${API_BASE}/projects`");
    expect(startup).toContain("fetch(`${API_BASE}/spaces`");
    expect(startup).toContain('resetProjectSessionHydration()');
    expect(startup).toContain('setRecentSessions(data, { requestedAt })');
  });
});
