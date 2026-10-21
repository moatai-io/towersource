import { expect, test as base, type Page, type Route } from '@playwright/test';

export const E2E_USER_ID = 9001;
export const E2E_PROJECT_ID = '10000000-0000-4000-8000-000000000001';
export const E2E_SESSION_A_ID = '20000000-0000-4000-8000-000000000001';
export const E2E_SESSION_B_ID = '20000000-0000-4000-8000-000000000002';

const now = '2026-10-02T10:00:00.000Z';
export const e2eSessions = [
  {
    id: E2E_SESSION_A_ID,
    shortCode: 'startpa2',
    short_code: 'startpa2',
    name: 'Startup Alpha',
    projectId: E2E_PROJECT_ID,
    cwd: '/workspace/projects/e2e',
    archived: false,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: E2E_SESSION_B_ID,
    shortCode: 'startpb2',
    short_code: 'startpb2',
    name: 'Startup Beta',
    projectId: E2E_PROJECT_ID,
    cwd: '/workspace/projects/e2e',
    archived: false,
    createdAt: now,
    updatedAt: '2026-10-02T09:00:00.000Z',
  },
];

const messages: Record<string, string> = {
  [E2E_SESSION_A_ID]: 'Authenticated fixture alpha message',
  [E2E_SESSION_B_ID]: 'Authenticated fixture beta message',
};

function syntheticJwt(payload: Record<string, unknown>) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.synthetic-signature`;
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function fullSessionPayload(sessionId: string) {
  const session = e2eSessions.find((entry) => entry.id === sessionId) ?? e2eSessions[0];
  return {
    session,
    messages: [{
      id: `message-${session.id}`,
      role: 'assistant',
      content: JSON.stringify([{ type: 'text', text: messages[session.id] }]),
      created_at: now,
    }],
    hasMore: false,
    oldestId: null,
  };
}

export async function installAuthenticatedState(page: Page, lastViewedSessionId?: string) {
  const token = syntheticJwt({
    userId: E2E_USER_ID,
    username: 'e2e-member',
    role: 'member',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  await page.addInitScript(({ token, userId, lastViewedSessionId }) => {
    localStorage.clear();
    localStorage.setItem('token', token);
    localStorage.setItem('userId', String(userId));
    localStorage.setItem('username', 'e2e-member');
    localStorage.setItem('tower:authCache', JSON.stringify({ authEnabled: true, hasUsers: true }));
    localStorage.setItem(`tower:guideSeen:${userId}`, 'true');
    if (lastViewedSessionId) localStorage.setItem(`tower_lastViewed_${userId}`, lastViewedSessionId);
  }, { token, userId: E2E_USER_ID, lastViewedSessionId });
}

export async function installAppApiRoutes(page: Page) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === '/api/auth/status') return json(route, { authEnabled: true, hasUsers: true });
    if (path === '/api/auth/check') return json(route, { valid: true, user: { id: E2E_USER_ID, username: 'e2e-member', role: 'member' } });
    if (path === '/api/branding/status') return json(route, { appBackgroundConfigured: false });
    if (path === '/api/config') return json(route, { agentFirstEnabled: false, aiServicesEnabled: false, inferenceReadiness: { status: 'ready' }, models: [], piModels: [], localModels: [] });
    if (path === '/api/projects') return json(route, [{ id: E2E_PROJECT_ID, name: 'E2E Project', archived: false, rootPath: '/workspace/projects/e2e' }]);
    if (path === '/api/spaces' || path === '/api/pins' || path === '/api/prompts' || path === '/api/git/log') return json(route, []);
    if (path === '/api/sessions' && request.method() === 'GET') return json(route, e2eSessions);
    const fullMatch = path.match(/^\/api\/sessions\/([^/]+)\/full$/);
    if (fullMatch) return json(route, fullSessionPayload(fullMatch[1]));
    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const session = e2eSessions.find((entry) => entry.id === sessionMatch[1] || entry.shortCode === sessionMatch[1]);
      return session ? json(route, session) : json(route, { error: 'not found' }, 404);
    }
    if (path === '/api/files/read') return json(route, { path: url.searchParams.get('path'), content: '# Default fixture file', language: 'markdown', encoding: 'utf-8' });

    return json(route, []);
  });
}

export async function prepareAuthenticatedPage(page: Page, lastViewedSessionId?: string) {
  await installAuthenticatedState(page, lastViewedSessionId);
  await installAppApiRoutes(page);
}

export const test = base.extend<{ authenticatedPage: Page }>({
  authenticatedPage: async ({ page }, use) => {
    await prepareAuthenticatedPage(page);
    await use(page);
  },
});

export { expect };
