import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), projects: vi.fn(), session: vi.fn(), readiness: vi.fn(), receiptsReady: vi.fn(), acknowledge: vi.fn() }));
vi.mock('../db/pg-repo.js', () => ({ query: m.query, queryOne: m.queryOne }));
vi.mock('../services/execution/execution-readiness.js', () => ({ getExecutionControlPlaneReadiness: m.readiness }));
vi.mock('../services/pm/project-membership-manager.js', () => ({ getAccessibleProjectIds: m.projects }));
vi.mock('../services/pm/project-access.js', () => ({ canAccessSession: m.session }));
vi.mock('../services/task/automation-result-receipts.js', () => ({ automationResultReceiptsReady: m.receiptsReady, acknowledgeAutomationResult: m.acknowledge, AutomationReceiptError: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock('../services/task/schedule-permissions.js', () => ({ canAccessAutomationJob: vi.fn(async () => ({ allowed: true })) }));
vi.mock('../config.js', () => ({ config: { authEnabled: true, jwtSecret: 'automation-results-http-test-only', tokenExpiry: '1h' } }));
import { authMiddleware, generateToken, invalidateAuthCache } from '../services/auth/auth.js';
import router from './automation-results-api.js';

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express(); app.use(express.json());
  // Production api.ts mounts the router after authMiddleware under /automations/results.
  app.use('/api/automations/results', authMiddleware, router);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP test address unavailable');
  base = `http://127.0.0.1:${address.port}/api/automations/results`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
});
beforeEach(() => {
  vi.clearAllMocks();
  for (const id of [7, 8, 9, 10]) invalidateAuthCache(id);
  m.queryOne.mockResolvedValue({ password_changed_at: null, disabled: 0, approval_status: 'active', role: 'member' });
  m.projects.mockResolvedValue(['project-a']); m.query.mockResolvedValue([]);
  m.session.mockResolvedValue({ allowed: true }); m.readiness.mockResolvedValue({ ready: true, missing: [] }); m.receiptsReady.mockResolvedValue(false);
});
const token = (id: number, role = 'member') => generateToken({ userId: id, username: `test-${id}`, role });
const get = (query = 'projectId=project-a', auth?: string) => fetch(`${base}?${query}`, {
  headers: auth ? { Authorization: `Bearer ${auth}` } : {},
});
const postReceipt = (runId: string, body: object, auth?: string) => fetch(`${base}/${runId}/receipt`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body),
});
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'run-a', automation_id: 'job-a', automation_name: 'Report', project_id: 'project-a',
  job_type: 'ai_prompt', automation_user_id: 7, status: 'failed', mode: 'spawn', result_id: null, error: 'failed',
  duration_ms: 34, ran_at: '2026-09-01T00:00:00Z', trigger: 'manual',
  started_at: null, finished_at: null, stdout_text: null, stderr_text: null,
  summary_text: 'Failed to run', error_json: null, runner_kind: 'system', runner_ref: null,
  execution_status: null, execution_session_id: null, ...overrides,
});

describe('GET /api/automations/results HTTP boundary', () => {
  it('derives personal receipt user from auth and rejects caller-supplied identity', async () => {
    m.acknowledge.mockResolvedValue({ readAt: '2026-09-28', actionedAt: null });
    const response = await postReceipt('run-a', { projectId: 'project-a', action: 'read' }, token(7));
    expect(response.status).toBe(200);
    expect(m.acknowledge).toHaveBeenCalledWith({ userId: 7, role: 'member', projectId: 'project-a', runId: 'run-a', action: 'read' });
    expect((await postReceipt('run-a', { projectId: 'project-a', action: 'read', userId: 8 }, token(7))).status).toBe(400);
    expect((await postReceipt('run-a', { projectId: 'project-a', action: 'read' })).status).toBe(401);
    expect((await postReceipt('run-a', { projectId: 'project-a', action: 'success' }, token(7))).status).toBe(400);
    expect(m.acknowledge).toHaveBeenCalledTimes(1);
  });
  it('rejects unauthenticated/invalid/disabled accounts before result queries', async () => {
    expect((await get()).status).toBe(401);
    expect((await get(undefined, 'invalid')).status).toBe(401);
    expect(m.query).not.toHaveBeenCalled();
    m.queryOne.mockResolvedValue({ password_changed_at: null, disabled: 1, approval_status: 'active', role: 'member' });
    expect((await get(undefined, token(7))).status).toBe(401);
    expect(m.query).not.toHaveBeenCalled();
  });

  it.each(['', 'limit=10', 'projectId=&limit=1', 'projectId=project-a&limit=0',
    'projectId=project-a&limit=-1', 'projectId=project-a&limit=101',
    'projectId=project-a&limit=1.5', 'projectId=project-a&limit=2garbage',
    'projectId=project-a&limit=1&limit=2', 'projectId=project-a&future=true',
    'projectId=project-a&projectId=project-b',
  ])('400 for invalid query %j before DB run read', async query => {
    expect((await get(query, token(7))).status).toBe(400);
    expect(m.query).not.toHaveBeenCalled();
  });

  it('rejects cross-project member even if they own a job there, before querying run contents', async () => {
    const response = await get('projectId=project-b', token(7));
    expect(response.status).toBe(403);
    expect(m.query).not.toHaveBeenCalled();
  });

  it.each([
    [7, 'member', ['project-a']], [8, 'member', ['project-a']],
    [9, 'operator', null], [10, 'admin', null],
  ] as const)('returns bounded results for member/owner/operator/admin %s (%s)', async (id, role, projects) => {
    m.queryOne.mockResolvedValue({ password_changed_at: null, disabled: 0, approval_status: 'active', role });
    m.projects.mockResolvedValue(projects);
    m.query.mockResolvedValue([
      row({ id: 'running', status: 'admitted', execution_status: 'running' }),
      row({ id: 'uncertain', status: 'admitted', execution_status: 'uncertain' }),
      row({ id: 'failed', status: 'failed', execution_status: 'failed' }),
      row({ id: 'sessionless', job_type: 'webhook', status: 'success', error: null }),
    ]);
    const response = await get('projectId=project-a&limit=4', token(id, role));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.map((item: any) => [item.run.id, item.run.status, item.executionStatus, item.sessionId]))
      .toEqual([
        ['running', 'admitted', 'running', null], ['uncertain', 'admitted', 'uncertain', null],
        ['failed', 'failed', 'failed', null], ['sessionless', 'success', undefined, null],
      ]);
    expect(body.items[0]).toMatchObject({ automationId: 'job-a', automationName: 'Report', projectId: 'project-a' });
    expect(m.query.mock.calls[0][1]).toEqual(['project-a', 4]);
  });

  it('returns legacy AI dispatch as outcomeUnverified in the HTTP schema without false completion', async () => {
    m.readiness.mockResolvedValue({ ready: false, missing: ['executions'] });
    m.query.mockResolvedValue([row({ status: 'success', runner_kind: 'ai', result_id: null, error: null })]);
    const response = await get(undefined, token(7));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items[0]).toMatchObject({ outcomeUnverified: true, run: { status: 'success' } });
    expect(m.query.mock.calls[0][0]).not.toContain('LEFT JOIN executions');
  });

  it('omits an inaccessible session and its unstructured content from the HTTP response', async () => {
    m.query.mockResolvedValue([row({ mode: 'inject', runner_kind: 'ai', result_id: 'session-secret',
      runner_ref: 'session-secret', summary_text: 'secret-session-summary', error: 'secret-session-error',
    })]);
    m.session.mockResolvedValue({ allowed: false, status: 403 });
    const response = await get(undefined, token(7));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.items[0]).toMatchObject({ sessionId: null, run: { status: 'failed', resultId: null, summaryText: null } });
    expect(JSON.stringify(body)).not.toMatch(/session-secret|secret-session-summary|secret-session-error/);
  });
});
