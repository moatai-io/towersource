import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePgPoolConfig } from './pg-pool-config.js';
import fs from 'node:fs';
const fake = vi.hoisted(() => ({ totalCount: 7, idleCount: 3, waitingCount: 2, on: vi.fn(), end: vi.fn().mockResolvedValue(undefined) }));
vi.mock('pg', () => ({ Pool: vi.fn(function () { return fake; }) }));
import { Pool } from 'pg';
import { closePgPool, getPgPool, getPgPoolDiagnostics } from './pg.js';
afterEach(async () => { await closePgPool(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('PG connection budget', () => {
  it('preserves 80 default and distinguishes production', () => {
    expect(resolvePgPoolConfig({})).toEqual({ max: 80, application_name: 'tower-dev' });
    expect(resolvePgPoolConfig({ NODE_ENV: 'production' }).application_name).toBe('tower-prod');
    expect(resolvePgPoolConfig({ TOWER_PG_POOL_MAX: '20', TOWER_PG_APPLICATION_NAME: 'tower-canary' }).max).toBe(20);
  });
  it.each(['', '0', '-1', '1.5', '80x', 'Infinity', '1001'])('rejects invalid max %s', value => {
    expect(() => resolvePgPoolConfig({ TOWER_PG_POOL_MAX: value })).toThrow('TOWER_PG_POOL_MAX');
  });
  it.each(['', 'with space', 'a'.repeat(64), '한글'])('rejects invalid label', value => {
    expect(() => resolvePgPoolConfig({ TOWER_PG_APPLICATION_NAME: value })).toThrow('TOWER_PG_APPLICATION_NAME');
  });
  it('does not create connections for diagnostics; reflects the live pool without URL', () => {
    expect(getPgPoolDiagnostics()).toMatchObject({ initialized: false, max: null, waiting: 0 });
    expect(Pool).not.toHaveBeenCalled();
    vi.stubEnv('DATABASE_URL', 'postgresql://example.invalid/synthetic');
    vi.stubEnv('TOWER_PG_POOL_MAX', '20');
    vi.stubEnv('TOWER_PG_APPLICATION_NAME', 'tower-test');
    getPgPool(); getPgPool();
    expect(Pool).toHaveBeenCalledTimes(1);
    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ max: 20, application_name: 'tower-test' }));
    expect(getPgPoolDiagnostics()).toMatchObject({ initialized: true, max: 20, total: 7, idle: 3, waiting: 2 });
    expect(JSON.stringify(getPgPoolDiagnostics())).not.toContain('example.invalid');
  });
  it('guards diagnostics behind the existing operator middleware', () => {
    const source = fs.readFileSync('packages/backend/routes/api.ts', 'utf8');
    expect(source).toContain("router.get('/admin/db-pool', operatorOrAboveMiddleware");
    expect(source).toContain("res.setHeader('Cache-Control', 'no-store')");
  });
});

it('resets the snapshot after closing and rereads config for a new pool', async () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://example.invalid/synthetic');
  vi.stubEnv('TOWER_PG_POOL_MAX', '20');
  getPgPool();
  await closePgPool();
  expect(getPgPoolDiagnostics()).toMatchObject({ initialized: false, max: null, total: 0 });
  vi.stubEnv('TOWER_PG_POOL_MAX', '30');
  getPgPool();
  expect(getPgPoolDiagnostics().max).toBe(30);
});
it('invalid budget fails before constructing a pool without echoing input', () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://example.invalid/synthetic');
  vi.stubEnv('TOWER_PG_POOL_MAX', 'sensitive-invalid-input');
  expect(() => getPgPool()).toThrow('TOWER_PG_POOL_MAX must be an integer between 1 and 1000');
  expect(Pool).not.toHaveBeenCalled();
  expect(getPgPoolDiagnostics().initialized).toBe(false);
});
