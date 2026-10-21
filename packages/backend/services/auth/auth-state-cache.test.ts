import fs from 'node:fs';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
// Execute the actual cache implementation without booting OAuth/config services.
const source = fs.readFileSync('packages/backend/services/auth/auth.ts', 'utf8');
const code = ts.transpileModule(source.slice(source.indexOf('interface AuthCacheEntry'), source.indexOf('/**\n * Lookup a user')), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const active = { password_changed_at: null, disabled: 0, approval_status: 'active', role: 'admin' };
function setup() {
  const query = vi.fn().mockResolvedValue(active);
  const api: any = {};
  new Function('exports', 'queryOne', code)(api, query);
  return { query, read: api.getUserAuthState as (id: number) => Promise<any>, invalidate: api.invalidateAuthCache as (id: number) => void };
}
afterEach(() => vi.useRealTimers());
it('coalesces 30 cold reads, preserves five-second TTL, and separates users', async () => {
  vi.useFakeTimers();
  const s = setup();
  await Promise.all(Array.from({ length: 30 }, () => s.read(1)));
  expect(s.query).toHaveBeenCalledTimes(1);
  await s.read(1); expect(s.query).toHaveBeenCalledTimes(1);
  await s.read(2); expect(s.query).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(5_000);
  await Promise.all(Array.from({ length: 30 }, () => s.read(1)));
  expect(s.query).toHaveBeenCalledTimes(3);
});
it('does not return or recache a pre-invalidation account state', async () => {
  const s = setup();
  let resolve!: (row: unknown) => void;
  s.query.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const old = Array.from({ length: 30 }, () => s.read(1));
  await Promise.resolve();
  s.invalidate(1);
  s.query.mockResolvedValue({ ...active, disabled: 1, role: 'member', password_changed_at: '2026-01-01T00:00:00Z' });
  resolve(active);
  const results = await Promise.all(old);
  expect(results.every(r => r.disabled && r.role === 'member' && r.passwordChangedAt > 0)).toBe(true);
  expect(s.query).toHaveBeenCalledTimes(2);
  expect((await s.read(1)).disabled).toBe(true);
});
it('propagates database failures to every waiter and allows retry', async () => {
  const s = setup(); s.query.mockRejectedValueOnce(new Error('synthetic unavailable'));
  const results = await Promise.allSettled(Array.from({ length: 30 }, () => s.read(1)));
  expect(results.every(r => r.status === 'rejected')).toBe(true);
  expect(s.query).toHaveBeenCalledTimes(1);
  expect((await s.read(1)).disabled).toBe(false);
  expect(s.query).toHaveBeenCalledTimes(2);
});
it('returns null for a missing account without caching authorization', async () => {
  const s = setup(); s.query.mockResolvedValue(null);
  expect(await s.read(1)).toBeNull(); expect(await s.read(1)).toBeNull();
  expect(s.query).toHaveBeenCalledTimes(2);
});
it('fails closed after repeated invalidation instead of looping indefinitely', async () => {
  const s = setup();
  s.query.mockImplementation(async () => { s.invalidate(1); return active; });
  await expect(s.read(1)).rejects.toThrow('Account state changed repeatedly');
  expect(s.query).toHaveBeenCalledTimes(3);
});
it('late invalidated readers reuse a completed replacement rather than issuing more SQL', async () => {
  const s = setup();
  let resolveOld!: (row: unknown) => void;
  s.query.mockImplementationOnce(() => new Promise(r => { resolveOld = r; }));
  const old = s.read(1);
  await Promise.resolve();
  s.invalidate(1);
  s.query.mockResolvedValue({ ...active, disabled: 1 });
  expect((await s.read(1)).disabled).toBe(true);
  resolveOld(active);
  expect((await old).disabled).toBe(true);
  expect(s.query).toHaveBeenCalledTimes(2);
});
