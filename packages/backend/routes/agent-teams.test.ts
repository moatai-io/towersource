import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ queryOne: vi.fn(), query: vi.fn(), issue: vi.fn(), apply: vi.fn() }));
vi.mock('../services/auth/auth.js', () => ({ authMiddleware: (req: any, res: any, next: any) => {
  if (!req.headers['x-user']) return res.status(401).json({ error: 'unauthorized' });
  req.user = { userId: Number(req.headers['x-user']), role: req.headers['x-role'] || 'admin', aud: req.headers['x-scope'] }; next();
} }));
vi.mock('../db/pg-repo.js', () => ({ queryOne: mocks.queryOne, query: mocks.query }));
vi.mock('../services/agent-workspaces/team-management-intent.js', () => ({ createTeamManagementIntent: mocks.issue, applyTeamManagementIntent: mocks.apply }));
import router from './agent-teams.js';
let server: http.Server;
let base: string;
const intentId = 'bc00365e-fcd1-430b-bdab-04b18051137a';
const proposalHash = 'a'.repeat(64);
async function request(url: string, body?: unknown, headers: Record<string, string> = { 'x-user': '1' }) {
  const response = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/agent-teams', router);
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent-teams`;
});
afterAll(async () => { vi.unstubAllEnvs(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('TOWER_TEAM_MANAGEMENT_ENABLED', '1');
  mocks.queryOne.mockResolvedValue({ role: 'admin', disabled: 0, approval_status: 'active' });
  mocks.query.mockResolvedValue([]);
  mocks.issue.mockResolvedValue({ intentId, proposalHash, expiresAt: '2030-01-01T00:00:00Z', preview: { command: { kind: 'invite', teamId: 'ta', userId: 2 }, warnings: ['Team file access expands; no Session sharing.'] } });
  mocks.apply.mockResolvedValue({ changed: true, teamVersion: 2 });
});

describe('agent team management HTTP boundary (not mounted by this module)', () => {
  it.each(['0', '', 'true'])('is inactive unless rollout is exactly 1 (%s)', async value => {
    vi.stubEnv('TOWER_TEAM_MANAGEMENT_ENABLED', value);
    expect((await request('/')).status).toBe(404); expect(mocks.queryOne).not.toHaveBeenCalled();
  });
  it('requires authentication', async () => { expect((await request('/', undefined, {})).status).toBe(401); });
  it.each([null, { role: 'operator', disabled: 0, approval_status: 'active' }, { role: 'admin', disabled: 1, approval_status: 'active' }, { role: 'admin', disabled: 0, approval_status: 'pending' }])('denies stale token admin against current account %j', async actor => {
    mocks.queryOne.mockResolvedValue(actor);
    expect((await request('/preview', { kind: 'create', teamId: 'ta', name: 'Team' })).status).toBe(403);
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it('uses current authenticated account, not cached/token role', async () => {
    expect((await request('/', undefined, { 'x-user': '1', 'x-role': 'member' })).status).toBe(200);
    expect(mocks.queryOne.mock.calls[0][1]).toEqual([1]);
  });
  it('does not let a subsystem-scoped token use the management router', async () => {
    expect((await request('/', undefined, { 'x-user': '1', 'x-scope': 'fleet' })).status).toBe(403);
    expect(mocks.queryOne).not.toHaveBeenCalled();
  });
  it('denies current nonadmin reads despite a cached admin role', async () => {
    mocks.queryOne.mockResolvedValue({ role: 'member', disabled: 0, approval_status: 'active' });
    expect((await request('/')).status).toBe(403);
    expect((await request('/ta')).status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('lists metadata without private fields or writes', async () => {
    mocks.query.mockResolvedValue([{ id: 'ta', name: 'Team', state: 'active', version: 1 }]);
    expect((await request('/')).body).toEqual({ teams: [{ id: 'ta', name: 'Team', state: 'active', version: 1 }] });
    expect(mocks.query.mock.calls[0][0]).not.toMatch(/sessions|credentials|root_path|INSERT|UPDATE|DELETE/i);
  });
  it('returns missing detail as 404', async () => {
    mocks.query.mockResolvedValue([]);
    expect((await request('/missing')).status).toBe(404);
  });
  it('returns bounded logical team/member/Agent metadata', async () => {
    mocks.query.mockResolvedValueOnce([{ id: 'ta', name: 'Team', state: 'active', version: 1 }])
      .mockResolvedValueOnce([{ userId: 2, state: 'active', role: 'member' }]).mockResolvedValueOnce([{ projectId: 'a' }]);
    expect((await request('/ta')).body).toEqual({ team: { id: 'ta', name: 'Team', state: 'active', version: 1 }, members: [{ userId: 2, state: 'active', role: 'member' }], agents: [{ projectId: 'a' }] });
  });
  it('fails closed on list/detail overflow instead of showing an incomplete management scope', async () => {
    mocks.query.mockResolvedValue(Array.from({ length: 257 }, (_, n) => ({ id: String(n) })));
    expect((await request('/')).status).toBe(409);
    mocks.query.mockResolvedValueOnce([{ id: 'ta' }]).mockResolvedValueOnce(Array.from({ length: 257 }, () => ({ userId: 2 }))).mockResolvedValueOnce([]);
    expect((await request('/ta')).status).toBe(409);
  });
  it.each([
    { kind: 'create', teamId: 'ta', name: 'Team' },
    { kind: 'revoke', teamId: 'ta', userId: 2 },
    { kind: 'assign', teamId: 'ta', projectId: 'a' },
  ])('accepts exact supported command: %j', async command => {
    expect((await request('/preview', command)).status).toBe(200);
    expect(mocks.issue).toHaveBeenCalledWith({ actorUserId: 1, command });
  });
  it('passes strict command to server-issued preview and marks uncomputed impacts unknown', async () => {
    const command = { kind: 'invite', teamId: 'ta', userId: 2 };
    const result = await request('/preview', command);
    expect(result.status).toBe(200); expect(mocks.issue).toHaveBeenCalledWith({ actorUserId: 1, command });
    expect(result.body.impact).toMatchObject({ eligibleAgentCount: null, registeredWorkspaceCount: null, affectedOwnSessionCount: null });
    expect(result.body.impact.note).toMatch(/확인되지/);
  });
  it.each([
    { kind: 'unknown', teamId: 'ta' }, { kind: 'invite', teamId: 'ta', userId: 0 },
    { kind: 'create', teamId: 'ta', name: '  ' }, { kind: 'assign', teamId: 'ta', projectId: '' },
    { kind: 'invite', teamId: 'ta', userId: 2, role: 'admin' },
    { kind: 'invite', teamId: 'ta', userId: 2, actorUserId: 3 },
    { kind: 'create', teamId: 'ta', name: 'Team', preview: {} },
  ])('rejects unknown command fields/invalid command: %j', async body => {
    expect((await request('/preview', body)).status).toBe(400); expect(mocks.issue).not.toHaveBeenCalled();
  });
  it('applies only actor closure and issued identifiers', async () => {
    expect((await request('/apply', { intentId, proposalHash, confirmed: true })).status).toBe(200);
    expect(mocks.apply).toHaveBeenCalledWith({ actorUserId: 1, intentId, proposalHash, confirmed: true });
  });
  it.each([
    { intentId, proposalHash, confirmed: false }, { intentId, proposalHash, confirmed: 'true' },
    { intentId, proposalHash, confirmed: true, preview: {} }, { intentId, proposalHash, confirmed: true, userId: 2 },
    { intentId, proposalHash, confirmed: true, role: 'admin' }, { intentId: 'invalid', proposalHash, confirmed: true },
  ])('rejects raw preview/identity/unconfirmed apply: %j', async body => {
    expect((await request('/apply', body)).status).toBe(400); expect(mocks.apply).not.toHaveBeenCalled();
  });
  it.each([
    ['TEAM_MANAGEMENT_INPUT_INVALID', 400], ['TEAM_MANAGEMENT_ADMIN_REQUIRED', 403],
    ['TEAM_MANAGEMENT_INTENT_BINDING', 403], ['TEAM_MANAGEMENT_INTENT_NOT_FOUND', 404],
    ['TEAM_MANAGEMENT_PREVIEW_STALE', 409], ['TEAM_MANAGEMENT_INTENT_CONSUMED', 409],
    ['TEAM_MANAGEMENT_INTENT_EXPIRED', 410], ['TEAM_MANAGEMENT_REASSIGNMENT_REQUIRES_MIGRATION', 409],
  ])('maps safe domain error %s to HTTP %s', async (error, status) => {
    mocks.apply.mockRejectedValue(new Error(error));
    const result = await request('/apply', { intentId, proposalHash, confirmed: true });
    expect(result.status).toBe(status); expect(result.body.error).toBe(error);
  });
  it('never returns internal SQL/error text', async () => {
    mocks.apply.mockRejectedValue(new Error('SELECT private_secret FROM database; connection failed'));
    const result = await request('/apply', { intentId, proposalHash, confirmed: true });
    expect(result.status).toBe(500); expect(JSON.stringify(result.body)).not.toMatch(/private_secret|SELECT|database/);
  });
});
