import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Client, Pool } from 'pg';
import { diagnoseFeedback } from './diagnostics.js';

// Same opt-in as the module's existing tests. New Unix-socket-only disposable PG;
// never reads DATABASE_URL, .env, live credentials or existing database contents.
describe.skipIf(process.env.FEEDBACK_DISPOSABLE_PG_TEST !== '1')('read-only feedback diagnostics on disposable PostgreSQL', () => {
  let root: string; let pool: Pool; let started = false;
  const bin = process.env.FEEDBACK_TEST_PG_BIN ?? '/usr/lib/postgresql/18/bin';
  const options = () => ({ host: path.join(root, 'socket'), port: 55442, database: 'postgres' });
  const env = { DATABASE_URL: 'synthetic-connector-marker-only' };
  const connect = async (role?: string) => {
    const db = new Client({ ...options(), user: role, options: '-c default_transaction_read_only=on' });
    await db.connect(); return db;
  };
  beforeAll(async () => {
    mkdirSync('work', { recursive: true }); root = mkdtempSync(path.resolve('work/feedback-diagnostic-pg-'));
    mkdirSync(path.join(root, 'socket'));
    execFileSync(path.join(bin, 'initdb'), ['-D', path.join(root, 'data'), '--auth=trust', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
    execFileSync(path.join(bin, 'pg_ctl'), ['-D', path.join(root, 'data'), '-l', path.join(root, 'postgres.log'),
      '-o', `-h '' -k ${path.join(root, 'socket')} -p 55442`, '-w', 'start'], { stdio: 'pipe' });
    started = true; pool = new Pool({ ...options(), max: 2 });
  }, 30000);
  afterAll(async () => {
    await pool?.end();
    if (root) {
      try { if (started) execFileSync(path.join(bin, 'pg_ctl'), ['-D', path.join(root, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' }); }
      finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
  it('handles an uninstalled schema and rejects persistent writes inside its transaction', async () => {
    const result = await diagnoseFeedback(env, () => connect());
    expect(result.database.tenants.state).toBe('missing'); expect(result.database.receipts.state).toBe('missing');
    const db = await connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await expect(db.query('CREATE TABLE should_never_exist(id int)')).rejects.toMatchObject({ code: '25006' });
    } finally { await db.query('ROLLBACK'); await db.end(); }
  });
  it('reports actual aggregate counts without exposing rows or modifying pending delivery', async () => {
    await pool.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    await pool.query("INSERT INTO public.feedback_tenants(id, token_hash, title_prefix, label) VALUES ('synthetic', $1, 'Synthetic', 'customer:synthetic')", ['a'.repeat(64)]);
    for (const [i, status] of ['accepted', 'delivering', 'delivered', 'needs_review', 'failed'].entries()) {
      await pool.query(`INSERT INTO public.feedback_receipts(id, tenant_id, idempotency_key, request_hash, reporter_user_id, payload, status, created_at, updated_at)
        VALUES ($1, 'synthetic', $2, repeat('b', 64), 7, '{"body":"synthetic-private-payload"}', $3, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')`,
      [`00000000-0000-4000-8000-00000000000${i}`, `synthetic-receipt-${i}`, status]);
    }
    const result = await diagnoseFeedback(env, () => connect());
    expect(result.database.tenants.counts).toEqual({ total: 1, active: 1, inactive: 0 });
    expect(result.database.receipts.counts).toEqual({ total: 5, accepted: 1, delivering: 1, delivered: 1, needs_review: 1, failed: 1, other: 0 });
    expect(result.activity).toEqual({ evidence: 'receipts_observed', pending: 2, attention: 2, deliveryOffWithPending: true });
    expect(result.database.receipts.latestUpdatedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private|synthetic-receipt|synthetic-hash|00000000/);
    expect((await pool.query("SELECT count(*) FROM public.feedback_receipts WHERE status = 'delivering'")).rows[0].count).toBe('1');
  });
  it('reports permission failure and RLS filtering as unknown, never empty', async () => {
    await pool.query('CREATE ROLE feedback_diagnostic_fixture LOGIN');
    let result = await diagnoseFeedback(env, () => connect('feedback_diagnostic_fixture'));
    expect(result.database.tenants.state).toBe('access_denied'); expect(result.database.receipts.state).toBe('access_denied');
    expect(result.activity.evidence).toBe('unknown');
    await pool.query('GRANT SELECT ON public.feedback_tenants, public.feedback_receipts TO feedback_diagnostic_fixture');
    await pool.query('ALTER TABLE public.feedback_receipts ENABLE ROW LEVEL SECURITY');
    result = await diagnoseFeedback(env, () => connect('feedback_diagnostic_fixture'));
    expect(result.database.tenants.state).toBe('available'); expect(result.database.receipts.state).toBe('row_security_limited');
    expect(result.activity.pending).toBeNull();
  });
  it('config-only subprocess does not use the fixture connection or inherited PG defaults', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'packages/backend/services/feedback-intake/diagnostics-cli.ts', '--config-only'],
      { env: { DATABASE_URL: 'invalid-synthetic-must-not-connect', PGPASSWORD: 'synthetic-do-not-read' }, encoding: 'utf8', timeout: 10000 });
    expect(r.status).toBe(0); expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout).database.state).toBe('not_requested');
    expect(r.stdout).not.toContain('synthetic');
  });
});
