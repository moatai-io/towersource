import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const service = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('../services/auth/auth.js', () => ({ authMiddleware: (req: any, res: any, next: any) => {
  if (!req.headers['x-user']) return res.status(401).json({ error: 'Authentication required' });
  if (req.headers['x-scope']) return res.status(403).json({ error: 'Scoped token denied' });
  req.user = { userId: Number(req.headers['x-user']), role: req.headers['x-role'] || 'admin' }; next();
} }));
vi.mock('../services/agent-workspaces/visual-teams.js', async () => {
  const actual = await vi.importActual<any>('../services/agent-workspaces/visual-teams.js');
  return { ...actual, getVisualTeams: service.get, patchVisualTeams: service.patch };
});
import router from './agent-visual-teams.js';
import { VisualTeamsError } from '../services/agent-workspaces/visual-teams.js';
let server: http.Server; let base: string;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api/agent-visual-teams', router);
  server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent-visual-teams`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => { vi.clearAllMocks(); service.get.mockResolvedValue({ version: 0, teams: [], assignments: {}, canManage: false }); service.patch.mockResolvedValue({ version: 1, teams: [], assignments: {}, canManage: true }); });
const request = (method: string, body?: unknown, headers: Record<string, string> = { 'x-user': '2' }) => fetch(base, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
describe('GET/PATCH /api/agent-visual-teams', () => {
  it('requires authentication and a valid actor id', async () => {
    expect((await request('GET', undefined, {})).status).toBe(401);
    expect((await request('GET', undefined, { 'x-user': 'nan' })).status).toBe(401);
    expect(service.get).not.toHaveBeenCalled();
  });
  it('calls fresh service with only actor identity, not cached JWT role', async () => {
    const response = await request('GET', undefined, { 'x-user': '2', 'x-role': 'admin' });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ canManage: false });
    expect(service.get).toHaveBeenCalledWith(2);
  });
  it('accepts only versioned command and normalizes team name', async () => {
    expect((await request('PATCH', { expectedVersion: 0, command: { kind: 'create', name: '  Team  ' } })).status).toBe(200);
    expect(service.patch).toHaveBeenCalledWith(2, { expectedVersion: 0, command: { kind: 'create', name: 'Team' } });
  });
  it('rejects authority injection and unsupported verbs', async () => {
    expect((await request('PATCH', { expectedVersion: 0, command: { kind: 'create', name: 'Team' }, actorUserId: 1 })).status).toBe(400);
    expect((await request('PATCH', { expectedVersion: 0, command: { kind: 'invite', userId: 1 } })).status).toBe(400);
    expect(service.patch).not.toHaveBeenCalled();
  });
  it.each([403, 404, 409])('preserves service error %s', async status => {
    service.patch.mockRejectedValue(new VisualTeamsError(status, 'Command rejected'));
    const response = await request('PATCH', { expectedVersion: 0, command: { kind: 'create', name: 'Team' } });
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: 'Command rejected' });
  });
  it('does not disclose DB/path failures', async () => {
    service.get.mockRejectedValue(new Error('/private/ SQL PASSWORD'));
    const response = await request('GET'); expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Visual teams unavailable' });
  });
  it('does not accept scoped auth bypass', async () => {
    expect((await request('GET', undefined, { 'x-user': '1', 'x-scope': 'gws-proxy' })).status).toBe(403);
    expect(service.get).not.toHaveBeenCalled();
  });
});
