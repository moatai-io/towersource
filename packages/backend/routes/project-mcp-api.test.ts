import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
function request(app: express.Express) {
  const operation = (method: string, url: string) => {
    let body: unknown; let params: Record<string, string> = {};
    const run = async () => {
      const server = createServer(app);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const target = `http://127.0.0.1:${(server.address() as AddressInfo).port}${url}?${new URLSearchParams(params)}`;
        const response = await fetch(target, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await response.text(); let json: any; try { json = JSON.parse(text); } catch {}
        return { status: response.status, headers: Object.fromEntries(response.headers), text, body: json };
      } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    };
    const op = { send: (value: unknown) => { body = value; return op; }, query: (value: Record<string, string>) => { params = value; return op; }, then: (resolve: any, reject: any) => run().then(resolve, reject) };
    return op;
  };
  return { get: (url: string) => operation('GET', url), post: (url: string) => operation('POST', url), delete: (url: string) => operation('DELETE', url) };
}
const m = vi.hoisted(() => ({ access: vi.fn(), manager: vi.fn(), read: vi.fn(), mutate: vi.fn(), validate: vi.fn(), start: vi.fn(), finish: vi.fn(), disconnect: vi.fn(), status: vi.fn() }));
vi.mock('../services/project-mcp/project-mcp-access.js', () => ({ assertProjectMcpAccess: m.access, assertProjectMcpManager: m.manager }));
vi.mock('../services/project-mcp/project-mcp-manifest.js', async importOriginal => {
  const mod = await importOriginal<any>(); return { ...mod, readManagedMcpManifest: m.read, mutateMcpManifest: m.mutate };
});
vi.mock('../services/project-mcp/project-mcp-network.js', () => ({ assertMcpPublicUrl: m.validate }));
vi.mock('../services/project-mcp/project-mcp-oauth.js', () => ({ startMcpOAuth: m.start, finishMcpOAuth: m.finish, disconnectMcpOAuth: m.disconnect, getMcpOAuthStatus: m.status, MCP_SHARED_ACCOUNT_NOTICE: 'shared account notice' }));
import router, { publicProjectMcpOAuthRouter } from './project-mcp-api.js';
function app(actor = true) {
  const app = express(); app.use(express.json()); app.use('/api', publicProjectMcpOAuthRouter);
  app.use((req, _res, next) => { if (actor) (req as any).user = { userId: 7, role: 'member' }; next(); });
  app.use('/api', router); return app;
}
const prefix = '/api/projects/agent/mcp';
beforeEach(() => {
  vi.resetAllMocks(); m.access.mockResolvedValue({ rootPath: '/synthetic', role: 'member' });
  m.manager.mockResolvedValue({ rootPath: '/synthetic', role: 'member' });
  m.read.mockResolvedValue({ servers: [{ name: 'notes', type: 'streamable-http', authType: 'oauth', url: 'https://provider.example.com/mcp' }] });
  m.start.mockResolvedValue('https://provider.example.com/authorize'); m.status.mockResolvedValue(true);
  m.mutate.mockImplementation(async (_root, mutate) => mutate([]));
});
describe('Agent MCP connection API', () => {
  it('returns secret-free metadata with management flag and shared warning', async () => {
    const res = await request(app()).get(`${prefix}/connections`);
    expect(res.status).toBe(200); expect(res.body.canManage).toBe(true); expect(res.body.authScope).toBe('agent');
    expect(res.body.connections[0]).toMatchObject({ id: 'notes', name: 'notes', status: 'connected', enabled: true });
    expect(JSON.stringify(res.body)).not.toMatch(/access_token|verifier|client_secret/);
  });
  it('permits accessible member read but denies management independently', async () => {
    m.manager.mockRejectedValue(Object.assign(new Error('denied'), { code: 'CREDENTIAL_MANAGEMENT_DENIED' }));
    const res = await request(app()).get(`${prefix}/connections`); expect(res.body.canManage).toBe(false);
    const write = await request(app()).post(`${prefix}/connections`).send({ name: 'notes', url: 'https://example.com', authType: 'oauth' });
    expect(write.status).toBe(403); expect(m.mutate).not.toHaveBeenCalled();
  });
  it('denies unauthenticated and inaccessible project listing', async () => {
    expect((await request(app(false)).get(`${prefix}/connections`)).status).toBe(401);
    m.access.mockRejectedValue(Object.assign(new Error('denied'), { status: 403 }));
    expect((await request(app()).get(`${prefix}/connections`)).status).toBe(403);
  });
  it('requires explicit shared-account acknowledgement before starting OAuth', async () => {
    expect((await request(app()).post(`${prefix}/connections/notes/auth/start`).send({})).status).toBe(400);
    expect(m.start).not.toHaveBeenCalled();
    const res = await request(app()).post(`${prefix}/connections/notes/auth/start`).send({ acknowledgeSharedAccount: true });
    expect(res.status).toBe(200); expect(res.body.authorizationUrl).toMatch(/^https:/);
    expect(m.start).toHaveBeenCalledWith('agent', 'notes', 7);
  });
  it('refuses command/headers/secrets input and SSRF validation failures', async () => {
    expect((await request(app()).post(`${prefix}/connections`).send({ name: 'notes', url: 'https://example.com/mcp', authType: 'oauth', headers: { Authorization: 'synthetic' } })).status).toBe(400);
    expect(m.mutate).not.toHaveBeenCalled();
    m.validate.mockRejectedValue(new Error('private network'));
    expect((await request(app()).post(`${prefix}/connections`).send({ name: 'notes', url: 'https://example.com/mcp', authType: 'oauth' })).status).toBe(400);
    expect(m.mutate).not.toHaveBeenCalled();
  });
  it('uses stored callback intent without browser bearer and ignores arbitrary returnUrl', async () => {
    const res = await request(app(false)).get(`${prefix}/oauth/callback`).query({ state: 'synthetic-state', code: 'synthetic-code', returnUrl: 'https://other.example.com' });
    expect(res.status).toBe(303); expect(res.headers.location).toBe('/?mcpAuth=connected');
    expect(res.headers['referrer-policy']).toBe('no-referrer'); expect(res.headers['cache-control']).toBe('no-store');
    expect(m.finish).toHaveBeenCalledWith('agent', 'synthetic-state', 'synthetic-code');
  });
  it('never reflects callback codes, state or provider errors', async () => {
    m.finish.mockRejectedValue(new Error('synthetic-sensitive-detail'));
    const res = await request(app(false)).get(`${prefix}/oauth/callback`).query({ state: 's', code: 'c' });
    expect(res.headers.location).toBe('/?mcpAuth=error'); expect(res.text).not.toContain('synthetic-sensitive-detail');
  });
  it('removes only the selected server and disconnects its stored auth', async () => {
    m.mutate.mockImplementation(async (_root, mutate) => { expect(mutate([{ name: 'notes' }, { name: 'other' }])).toEqual([{ name: 'other' }]); });
    const res = await request(app()).delete(`${prefix}/connections/notes`);
    expect(res.body).toEqual({ removed: true }); expect(m.disconnect).toHaveBeenCalledWith('agent', 'notes', 7);
  });
});
