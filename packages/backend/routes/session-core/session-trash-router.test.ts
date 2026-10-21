import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
const m = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), restore: vi.fn(), read: vi.fn(), write: vi.fn(), row: vi.fn(), broadcast: vi.fn() }));
vi.mock('../../services/session/session-manager.js', () => ({ getArchivedSessions: m.list, getSession: m.get, restoreSession: m.restore }));
vi.mock('../../services/pm/project-access.js', () => ({ canAccessSession: m.read, canDeleteSession: m.write }));
vi.mock('../../db/pg-repo.js', () => ({ queryOne: m.row }));
vi.mock('../ws-handler.js', () => ({ broadcastToUser: m.broadcast }));
import router from './session-trash-router.js';
let server: Server, base: string, user: any;
beforeEach(async () => {
  vi.resetAllMocks(); user = { userId: 10, role: 'member' };
  m.list.mockResolvedValue([{ id: 'own', name: 'Own' }]);
  m.get.mockResolvedValue({ id: 'own', name: 'Own' });
  m.restore.mockResolvedValue(true);
  m.row.mockImplementation(async (sql: string) => sql.includes('FROM sessions') ? { user_id: 10, archived: 1 } : null);
  m.read.mockResolvedValue({ allowed: true }); m.write.mockResolvedValue({ allowed: true });
  const app = express(); app.use((req, _res, next) => { (req as any).user = user; next(); }); app.use(router);
  server = createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>(r => server.close(() => r())); });
describe('Session Archive HTTP', () => {
  it('lists own archive without search and checks audience', async () => {
    expect(await (await fetch(base + '/sessions/archived')).json()).toEqual([{ id: 'own', name: 'Own' }]);
    expect(m.list).toHaveBeenCalledWith(10, 'member');
    m.read.mockResolvedValue({ allowed: false, status: 403 });
    expect(await (await fetch(base + '/sessions/archived')).json()).toEqual([]);
  });
  it('retains the non-destructive legacy list alias', async () => {
    expect((await fetch(base + '/sessions/trash')).status).toBe(200);
  });
  it('is idempotent for an already active session', async () => {
    m.row.mockImplementation(async (sql: string) => sql.includes('FROM sessions') ? { user_id: 10, archived: 0 } : null);
    expect((await fetch(base + '/sessions/own/restore', { method: 'POST' })).status).toBe(200);
    expect(m.restore).not.toHaveBeenCalled();
  });
  it('requires authentication for listing and restoring', async () => {
    user = undefined;
    expect((await fetch(base + '/sessions/archived')).status).toBe(401);
    expect((await fetch(base + '/sessions/own/restore', { method: 'POST' })).status).toBe(401);
    expect(m.list).not.toHaveBeenCalled(); expect(m.restore).not.toHaveBeenCalled();
  });
  it('restores an owned session and notifies its owner', async () => {
    expect((await fetch(base + '/sessions/own/restore', { method: 'POST' })).status).toBe(200);
    expect(m.restore).toHaveBeenCalledWith('own');
    expect(m.broadcast).toHaveBeenCalledWith(10, { type: 'session_created', session: { id: 'own', name: 'Own' } });
  });
  it('rejects another owner even for admin', async () => {
    user.role = 'admin'; m.row.mockResolvedValue({ user_id: 20, archived: 1 });
    expect((await fetch(base + '/sessions/own/restore', { method: 'POST' })).status).toBe(403);
    expect(m.restore).not.toHaveBeenCalled();
  });
  it.each(['read', 'write'] as const)('requires %s authority', async key => {
    m[key].mockResolvedValue({ allowed: false, status: 403, message: 'Denied' });
    expect((await fetch(base + '/sessions/own/restore', { method: 'POST' })).status).toBe(403);
    expect(m.restore).not.toHaveBeenCalled();
  });
  it('does not resume or modify worker lifecycle', async () => {
    m.row.mockImplementation(async (sql: string) => sql.includes('FROM sessions') ? { user_id: 10, archived: 1 } : { id: 'worker' });
    expect((await fetch(base + '/sessions/own/restore', { method: 'POST' })).status).toBe(409);
    expect(m.restore).not.toHaveBeenCalled();
  });
  it('reports missing sessions and storage errors', async () => {
    m.row.mockResolvedValue(null);
    expect((await fetch(base + '/sessions/own/restore', { method: 'POST' })).status).toBe(404);
    m.list.mockRejectedValue(new Error('db'));
    expect((await fetch(base + '/sessions/archived')).status).toBe(500);
  });
});
