import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ queryOne: vi.fn(), preview: vi.fn(), activate: vi.fn() }));
vi.mock('../db/pg-repo.js', () => ({ queryOne: state.queryOne, query: vi.fn(), execute: vi.fn(), transaction: vi.fn() }));
vi.mock('../config.js', () => ({ config: { authEnabled: true, jwtSecret: 'create-plan-http-test-only', tokenExpiry: '1h' } }));
vi.mock('../services/task/automation-create-plan.js', () => ({
  AutomationPlanError: class extends Error { constructor(message: string, public status = 400) { super(message); } },
  previewAutomationCreation: state.preview, activateAutomationCreation: state.activate,
}));
import router from './automation-create-api.js';
import { generateToken, invalidateAuthCache } from '../services/auth/auth.js';
import { AutomationPlanError } from '../services/task/automation-create-plan.js';
let server: Server; let base: string;
const token = () => generateToken({ userId: 7, username: 'synthetic-user', role: 'member' } as any);
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api/automations/creation-plans', router);
  server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => {
  vi.clearAllMocks(); invalidateAuthCache(7);
  state.queryOne.mockResolvedValue({ id: 7, username: 'synthetic-user', role: 'member', disabled: 0, account_state: 'active' });
  state.preview.mockResolvedValue({ kind: 'clarification', field: 'trigger', message: 'time required' });
  state.activate.mockResolvedValue({ automation: { id: 'a1', enabled: true }, replayed: false });
});
async function post(url: string, body: unknown, auth = true) {
  return fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token()}` } : {}) }, body: JSON.stringify(body) });
}
describe('creation plan actual router/JWT boundary', () => {
  it('rejects anonymous without invoking services', async () => {
    expect((await post('/automations/creation-plans', {}, false)).status).toBe(401);
    expect(state.preview).not.toHaveBeenCalled();
  });
  it('passes actor only from authenticated context and asks clarification', async () => {
    const r = await post('/automations/creation-plans', { request: 'summary', projectId: 'p1' });
    expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ kind: 'clarification' });
    expect(state.preview).toHaveBeenCalledWith({ request: 'summary', projectId: 'p1' }, { userId: 7, role: 'member' });
  });
  it('preserves permission denial and sanitizes unexpected errors', async () => {
    state.preview.mockRejectedValueOnce(new AutomationPlanError('forbidden', 403));
    expect((await post('/automations/creation-plans', {})).status).toBe(403);
    state.preview.mockRejectedValueOnce(new Error('private DB detail'));
    const r = await post('/automations/creation-plans', {});
    expect(r.status).toBe(500); expect(JSON.stringify(await r.json())).not.toContain('private DB');
  });
  it('passes exact hash and confirmation; unknown activation fields rejected', async () => {
    const hash = 'a'.repeat(64);
    const r = await post('/automations/creation-plans/a1/activate', { confirmed: true, proposalHash: hash });
    expect(r.status).toBe(200);
    expect(state.activate).toHaveBeenCalledWith('a1', hash, { userId: 7, role: 'member' }, true);
    expect((await post('/automations/creation-plans/a1/activate', { confirmed: true, proposalHash: hash, enabled: true })).status).toBe(400);
    expect(state.activate).toHaveBeenCalledTimes(1);
  });
});
