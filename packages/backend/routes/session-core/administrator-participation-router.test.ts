import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ one: vi.fn(), change: vi.fn(), list: vi.fn(), member: vi.fn(), room: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ queryOne: mocks.one }));
vi.mock('../../services/pm/project-access.js', () => ({ canAccessRoom: mocks.room }));
vi.mock('../../services/pm/project-membership-manager.js', () => ({ isProjectMember: mocks.member }));
vi.mock('../../services/pm/administrator-participation.js', () => ({
  changeAdministratorParticipation: mocks.change, listAdministratorParticipants: mocks.list,
  ParticipationError: class extends Error { constructor(public status: number, message: string) { super(message); } },
}));
import router from './administrator-participation-router.js';
let server: Server;
let base: string;
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.one.mockResolvedValue({ role: 'operator', disabled: 0 });
  mocks.change.mockResolvedValue({ changed: true, joined: true, participationId: 'part', eventId: 'event' });
  mocks.list.mockResolvedValue([{ id: 'part', userId: 7, username: 'manager', joinedAt: 'now' }]);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { userId: 7, role: 'operator' }; next(); });
  app.use(router); server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/administrator-participation`;
});
afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); });
async function request(method: string, body: unknown = {}, target = '/project/p') {
  return fetch(base + target, { method, ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
}
it('lists visible participants for company management', async () => {
  const response = await request('GET');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ scope: 'project', targetId: 'p', participants: [{ userId: 7 }] });
});
it.each(['POST', 'DELETE'])('requires explicit confirmation for %s', async method => {
  expect((await request(method)).status).toBe(400);
  expect(mocks.change).not.toHaveBeenCalled();
});
it.each(['POST', 'DELETE'])('dispatches %s to exactly one audience scope and actor', async method => {
  expect((await request(method, { confirmed: true }, '/channel/room')).status).toBe(200);
  expect(mocks.change).toHaveBeenCalledWith({ scope: 'channel', targetId: 'room', userId: 7, join: method === 'POST' });
});
it('does not accept a session/private grant scope', async () => {
  expect((await request('POST', { confirmed: true }, '/session/private')).status).toBe(400);
  expect(mocks.change).not.toHaveBeenCalled();
});
it('rejects disabled stale-token actors before reads or writes', async () => {
  mocks.one.mockResolvedValue({ role: 'operator', disabled: 1 });
  expect((await request('GET')).status).toBe(403);
  expect((await request('POST', { confirmed: true })).status).toBe(403);
});
it('does not report success when durable participation/audit transaction fails', async () => {
  mocks.change.mockRejectedValue(new Error('storage failure'));
  expect((await request('POST', { confirmed: true })).status).toBe(503);
});
