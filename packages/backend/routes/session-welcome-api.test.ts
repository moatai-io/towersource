import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
const welcome = vi.hoisted(() => vi.fn());
vi.mock('../services/welcome/session-welcome.js', async original => {
  const actual = await original<typeof import('../services/welcome/session-welcome.js')>();
  return { ...actual, getSessionWelcome: welcome };
});
import router from './session-welcome-api.js';
import { WelcomeAccessError, welcomeFallback } from '../services/welcome/session-welcome.js';
const projectId = '44444444-4444-4444-8444-444444444444';
const sessionId = '55555555-5555-4555-8555-555555555555';
async function call(body: unknown, user: unknown = { userId: 7, role: 'member' }) {
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { (req as any).user = user; next(); }); app.use('/api/session-welcome', router);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/session-welcome`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json(), cache: response.headers.get('cache-control') };
  } finally { server.close(); }
}
beforeEach(() => { welcome.mockReset(); welcome.mockResolvedValue(welcomeFallback('ko')); });
describe('POST /api/session-welcome', () => {
  it('requires closure identity and strict UUID/input shape', async () => {
    expect((await call({ projectId, sessionId, locale: 'ko' }, null)).status).toBe(401);
    for (const body of [{ projectId, sessionId: 'bad', locale: 'ko' }, { projectId, sessionId, locale: 'ko', userId: 99 }, { projectId, sessionId, locale: '<script>' }, { projectId, sessionId }]) expect((await call(body)).status).toBe(400);
    expect(welcome).not.toHaveBeenCalled();
  });
  it('normalizes locale, uses authenticated principal, and sends no-store', async () => {
    const response = await call({ projectId, sessionId, locale: 'ko-KR' });
    expect(response.status).toBe(200); expect(response.json).toEqual(welcomeFallback('ko')); expect(response.cache).toBe('no-store');
    expect(welcome).toHaveBeenCalledWith({ userId: 7, role: 'member', projectId, sessionId, locale: 'ko' });
  });
  it('preserves authorization errors and sanitizes storage failures', async () => {
    welcome.mockRejectedValueOnce(new WelcomeAccessError(403)); expect((await call({ projectId, sessionId, locale: 'en' })).status).toBe(403);
    welcome.mockRejectedValueOnce(new Error('password sql private')); const failed = await call({ projectId, sessionId, locale: 'en' });
    expect(failed.status).toBe(503); expect(failed.json).toEqual({ error: 'Welcome unavailable' });
  });
});
