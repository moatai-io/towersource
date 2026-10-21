import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ queryOne: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ queryOne: mocks.queryOne, query: vi.fn(), execute: vi.fn(), transaction: vi.fn() }));
vi.mock('../../config.js', () => ({ config: { authEnabled: true, jwtSecret: 'synthetic-test-only', tokenExpiry: '1h' } }));
import { authMiddleware, generateToken, invalidateAuthCache, verifyWsToken } from './auth.js';
const active = { password_changed_at: null, disabled: 0, approval_status: 'active', role: 'member' };
const token = () => generateToken({ userId: 901, username: 'synthetic', role: 'admin' });
function http(t = token()) {
  const req: any = { headers: { authorization: `Bearer ${t}`, cookie: 'tower_token=synthetic' }, query: {}, path: '/sessions' };
  const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), cookie: vi.fn() };
  const next = vi.fn();
  return { req, res, next, done: authMiddleware(req, res, next) };
}
beforeEach(() => { invalidateAuthCache(901); mocks.queryOne.mockReset().mockResolvedValue(active); });
afterEach(() => vi.restoreAllMocks());
it('HTTP and WS authentication share one lookup and refresh token roles from DB', async () => {
  const requests = Array.from({ length: 15 }, () => http());
  const sockets = Array.from({ length: 15 }, () => verifyWsToken(token()));
  await Promise.all(requests.map(r => r.done));
  const identities = await Promise.all(sockets);
  expect(mocks.queryOne).toHaveBeenCalledTimes(1);
  for (const r of requests) { expect(r.next).toHaveBeenCalledOnce(); expect(r.req.user.role).toBe('member'); }
  expect(identities.every(i => i?.role === 'member')).toBe(true);
});
it('in-flight HTTP and WS requests reject an account disabled during lookup', async () => {
  let resolve!: (row: unknown) => void;
  mocks.queryOne.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const request = http(); const socket = verifyWsToken(token());
  await Promise.resolve();
  invalidateAuthCache(901);
  mocks.queryOne.mockResolvedValue({ ...active, disabled: 1 });
  resolve(active);
  await request.done;
  expect(request.res.status).toHaveBeenCalledWith(401); expect(request.next).not.toHaveBeenCalled();
  expect(await socket).toBeNull(); expect(mocks.queryOne).toHaveBeenCalledTimes(2);
});
it('DB errors fail HTTP closed and reject WS verification; a subsequent request recovers', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.queryOne.mockRejectedValueOnce(new Error('synthetic DB failure'));
  const request = http();
  const socket = expect(verifyWsToken(token())).rejects.toThrow('synthetic DB failure');
  await request.done; await socket;
  expect(request.res.status).toHaveBeenCalledWith(503); expect(request.next).not.toHaveBeenCalled();
  const recovered = http(); await recovered.done; expect(recovered.next).toHaveBeenCalledOnce();
});
it('reactivation rejects pre-disable browser and scoped tokens even inside iat grace', async () => {
  const old = token();
  const scoped = generateToken({ userId: 901, username: 'synthetic', role: 'admin', aud: 'tower-cli' });
  mocks.queryOne.mockResolvedValue({ ...active, auth_epoch: 1 });
  const request = http(old); await request.done;
  expect(request.res.status).toHaveBeenCalledWith(401);
  expect(request.next).not.toHaveBeenCalled();
  expect(await verifyWsToken(old)).toBeNull();
  expect(await verifyWsToken(scoped)).toBeNull();
  const fresh = generateToken({ userId: 901, username: 'synthetic', role: 'member', authEpoch: 1 });
  expect((await verifyWsToken(fresh))?.userId).toBe(901);
});
it('password changes still invalidate existing browser tokens for HTTP and WS', async () => {
  const t = token();
  mocks.queryOne.mockResolvedValue({ ...active, password_changed_at: new Date(Date.now() + 10_000).toISOString() });
  const request = http(t); await request.done;
  expect(request.res.status).toHaveBeenCalledWith(401); expect(request.next).not.toHaveBeenCalled();
  expect(await verifyWsToken(t)).toBeNull();
});
