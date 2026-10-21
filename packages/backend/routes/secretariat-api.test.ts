import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
vi.mock('../services/secretariat/service.js', () => ({ secretariatService: {}, SecretariatAccessError: class extends Error {} }));
import { createSecretariatRouter } from './secretariat-api.js';
async function request(method: string, path: string, body?: unknown, identity: any = { userId: 7, role: 'member' }) {
  const service = { inbox: vi.fn().mockResolvedValue({ enabled: false, pausedReason: null, proposals: [] }),
    setEnabled: vi.fn().mockResolvedValue({ enabled: true }), read: vi.fn().mockResolvedValue(true), runUser: vi.fn(), respond: vi.fn().mockResolvedValue(true) };
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { (req as any).user = identity; next(); });
  app.use('/api/secretariat', createSecretariatRouter(service));
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address() as any;
    const response = await fetch(`http://127.0.0.1:${addr.port}/api/secretariat${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), cache: response.headers.get('Cache-Control'), service };
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
describe('Secretariat authenticated personal API', () => {
  it('GET preserves frontend contract, owner closure, no-store', async () => {
    const result = await request('GET', ''); expect(result.status).toBe(200);
    expect(result.body).toEqual({ enabled: false, pausedReason: null, proposals: [] }); expect(result.cache).toBe('no-store');
    expect(result.service.inbox).toHaveBeenCalledWith(7);
  });
  it.each([null, { userId: 7, role: 'viewer' }, { userId: '7', role: 'member' }])('denies ineligible/missing identity', async identity => {
    const result = await request('GET', '', undefined, identity); expect(result.status).toBe(403); expect(result.service.inbox).not.toHaveBeenCalled();
  });
  it.each([{ enabled: 'true' }, { enabled: true, userId: 8 }, {}, { enabled: true, prompt: 'run' }])('rejects invalid/mass-assignment settings', async body => {
    const result = await request('PATCH', '', body); expect(result.status).toBe(400); expect(result.service.setEnabled).not.toHaveBeenCalled();
  });
  it('PATCH changes only authenticated user settings', async () => {
    const result = await request('PATCH', '', { enabled: true }); expect(result.status).toBe(200);
    expect(result.service.setEnabled).toHaveBeenCalledWith(7, true);
  });
  it('read is scoped to owner and strict UUID; admin cannot choose another owner', async () => {
    const id = '7dff52ab-e301-400e-a65e-f61f76ad7c62';
    const result = await request('POST', `/proposals/${id}/read`, { userId: 8 }, { userId: 7, role: 'admin' });
    expect(result.status).toBe(200); expect(result.service.read).toHaveBeenCalledWith(7, id);
    expect((await request('POST', '/proposals/invalid/read')).status).toBe(400);
  });
});

it('manual briefing is account-bound and rejects caller-supplied scope', async () => {
  const result = await request('POST', '/briefing', {});
  expect(result.status).toBe(200); expect(result.service.runUser).toHaveBeenCalledWith(7, true);
  const invalid = await request('POST', '/briefing', { userId: 8 });
  expect(invalid.status).toBe(400); expect(invalid.service.runUser).not.toHaveBeenCalled();
});
