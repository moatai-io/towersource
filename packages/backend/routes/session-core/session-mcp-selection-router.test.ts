import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
const m = vi.hoisted(() => ({ get: vi.fn(), read: vi.fn(), write: vi.fn(), selection: vi.fn(), save: vi.fn() }));
vi.mock('../../services/session/session-manager.js', () => ({ getSession: m.get }));
vi.mock('../../services/pm/project-access.js', () => ({ canAccessSession: m.read, canSendSessionMessage: m.write }));
vi.mock('../../services/session/session-mcp-selection.js', () => ({ getSessionMcpSelection: m.selection, setSessionMcpSelection: m.save }));
import router from './session-mcp-selection-router.js';
let server: Server, base: string;
let user: { userId: number; role: string } | undefined;
const result = { sessionId: 's', projectId: 'p', supported: true, excludedServerNames: ['drive'] };
beforeEach(async () => {
  vi.resetAllMocks();
  user = { userId: 10, role: 'member' };
  m.get.mockResolvedValue({ id: 's', projectId: 'p', engine: 'pi' });
  m.read.mockResolvedValue({ allowed: true }); m.write.mockResolvedValue({ allowed: true });
  m.selection.mockResolvedValue(result); m.save.mockResolvedValue(result);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = user; next(); }); app.use(router);
  server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sessions/s/mcp-selection`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
function patch(body: unknown) { return fetch(base, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
describe('Pi MCP conversation selection API', () => {
  it('returns selection only after canonical session ACL', async () => {
    expect(await (await fetch(base)).json()).toEqual(result);
    expect(m.read).toHaveBeenCalledWith('s', 10, 'member');
  });
  it('replaces the list with send authority and detects current project', async () => {
    expect((await patch({ excludedServerNames: ['drive'], projectId: 'p' })).status).toBe(200);
    expect(m.write).toHaveBeenCalledWith('s', 10, 'member');
    expect(m.save).toHaveBeenCalledWith('s', 'p', ['drive']);
  });
  it('rejects read-only shares and nonmembers before persistence', async () => {
    m.write.mockResolvedValue({ allowed: false, status: 403, message: 'Access denied' });
    expect((await patch({ excludedServerNames: [] })).status).toBe(403);
    expect(m.save).not.toHaveBeenCalled();
    m.read.mockResolvedValue({ allowed: false, status: 403, message: 'Access denied' });
    expect((await fetch(base)).status).toBe(403); expect(m.selection).not.toHaveBeenCalled();
  });
  it('rejects a former member even when owner/send authority would pass', async () => {
    m.read.mockResolvedValue({ allowed: false, status: 403, message: 'Project membership required' });
    expect((await patch({ excludedServerNames: [] })).status).toBe(403);
    expect(m.write).not.toHaveBeenCalled(); expect(m.save).not.toHaveBeenCalled();
  });
  it('requires authentication', async () => {
    user = undefined;
    expect((await fetch(base)).status).toBe(401);
    expect((await patch({ excludedServerNames: [] })).status).toBe(401);
  });
  it.each([{}, { excludedServerNames: null }, { excludedServerNames: ['../drive'] }, { excludedServerNames: [], enabled: true }, { excludedServerNames: Array(65).fill('drive') }, { excludedServerNames: [], projectId: 1 }])('rejects invalid input %j', async body => {
    expect((await patch(body)).status).toBe(400); expect(m.save).not.toHaveBeenCalled();
  });
  it('rejects stale project scope without writing', async () => {
    expect((await patch({ excludedServerNames: [], projectId: 'another-project' })).status).toBe(409);
    expect(m.save).not.toHaveBeenCalled();
  });
  it('detects a session moving between ACL check and update', async () => {
    m.save.mockResolvedValue(undefined);
    expect((await patch({ excludedServerNames: [] })).status).toBe(409);
  });
  it('does not alter Claude sessions', async () => {
    m.get.mockResolvedValue({ id: 's', projectId: 'p', engine: 'claude' });
    expect((await patch({ excludedServerNames: [] })).status).toBe(409); expect(m.save).not.toHaveBeenCalled();
  });
  it('reports non-Pi read support without allowing mutations', async () => {
    m.selection.mockResolvedValue({ ...result, supported: false });
    expect(await (await fetch(base)).json()).toEqual({ ...result, supported: false });
  });
  it('returns not found and sanitized storage errors', async () => {
    m.selection.mockResolvedValueOnce(undefined);
    expect((await fetch(base)).status).toBe(404);
    m.selection.mockRejectedValueOnce(new Error('database unavailable'));
    const response = await fetch(base); expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to read MCP selection' });
  });
});
