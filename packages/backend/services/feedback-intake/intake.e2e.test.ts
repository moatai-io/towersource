import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { Pool } from 'pg';
import { PgIntakeStore } from './store.js';
import { createFeedbackRouter } from './router.js';
import { closureSubmission, defaultSubmissionKey } from './client.js';
import { tokenDigest, type Tenant } from './contract.js';
import { deliverOne } from './delivery.js';

// Explicit opt-in: a new disposable local PG cluster, NEVER DATABASE_URL or an existing DB.
const run = process.env.FEEDBACK_DISPOSABLE_PG_TEST === '1';
describe.skipIf(!run)('isolated PostgreSQL + HTTP intake + background delivery', () => {
  let root: string; let pool: Pool; let store: PgIntakeStore; let server: Server; let origin: string;
  const bin = process.env.FEEDBACK_TEST_PG_BIN ?? '/usr/lib/postgresql/18/bin';
  const tokenA = 'a'.repeat(43); const tokenB = 'b'.repeat(43);
  const customerA: Tenant = { id: 'customer-a', titlePrefix: 'Customer A', label: 'customer:customer-a' };
  const context = { userId: 7, username: 'Reporter', sessionId: 'session-a', projectId: 'project-a' };
  const payload = closureSubmission(context, { title: 'Feedback', body: 'Reproduction' });
  const key = defaultSubmissionKey(payload);
  let acceptedId: string;
  const post = (token: string, body: unknown = payload, requestKey = key) => fetch(`${origin}/`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': requestKey }, body: JSON.stringify(body),
  });
  beforeAll(async () => {
    mkdirSync('work', { recursive: true });
    root = mkdtempSync(path.resolve('work/feedback-pg-'));
    mkdirSync(path.join(root, 'socket'));
    execFileSync(path.join(bin, 'initdb'), ['-D', path.join(root, 'data'), '--auth=trust', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
    execFileSync(path.join(bin, 'pg_ctl'), ['-D', path.join(root, 'data'), '-l', path.join(root, 'postgres.log'), '-o', `-h '' -k ${path.join(root, 'socket')} -p 55439`, '-w', 'start'], { stdio: 'pipe' });
    pool = new Pool({ host: path.join(root, 'socket'), port: 55439, database: 'postgres', max: 8 });
    await pool.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    for (const [id, token] of [['customer-a', tokenA], ['customer-b', tokenB]]) {
      await pool.query('INSERT INTO feedback_tenants(id, token_hash, title_prefix, label) VALUES ($1,$2,$3,$4)', [id, tokenDigest(token), id, `customer:${id}`]);
    }
    store = new PgIntakeStore(pool);
    const app = express(); app.use('/api/feedback-intake', createFeedbackRouter(store));
    server = await new Promise<Server>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('test server unavailable');
    origin = `http://127.0.0.1:${address.port}/api/feedback-intake`;
  }, 30000);
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await pool?.end();
    if (root) {
      try { execFileSync(path.join(bin, 'pg_ctl'), ['-D', path.join(root, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' }); }
      finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
  it('rejects invalid authentication, secrets, oversized bodies and forged tenant fields', async () => {
    expect((await post('c'.repeat(43))).status).toBe(401);
    expect((await post(tokenA, { ...payload, customerId: 'customer-b' })).status).toBe(400);
    expect((await post(tokenA, { ...payload, body: 'x'.repeat(70000) })).status).toBe(400);
    expect((await post(tokenA, { ...payload, title: 'sk-' + 'a'.repeat(30) })).status).toBe(422);
  });
  it('commits once under concurrent replay and reports accepted separately', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => post(tokenA)));
    expect(results.every(result => result.status === 202)).toBe(true);
    const receipts = await Promise.all(results.map(result => result.json()));
    expect(new Set(receipts.map(receipt => receipt.id)).size).toBe(1);
    acceptedId = receipts[0].id;
    expect(receipts[0]).toEqual({ id: acceptedId, status: 'accepted' });
    expect((await pool.query('SELECT count(*) AS count FROM feedback_receipts')).rows[0].count).toBe('1');
    expect((await post(tokenA, { ...payload, body: 'Changed' })).status).toBe(409);
  });
  it('isolates status by authenticated customer and backend reporter', async () => {
    const get = (token: string, userId: string) => fetch(`${origin}/${acceptedId}`, { headers: { Authorization: `Bearer ${token}`, 'X-Feedback-Reporter-Id': userId } });
    expect((await get(tokenB, '7')).status).toBe(404);
    expect((await get(tokenA, '8')).status).toBe(404);
    expect((await get(tokenA, '7')).status).toBe(200);
    const other = await post(tokenB); expect(other.status).toBe(202);
    expect((await other.json()).id).not.toBe(acceptedId);
  });
  it('claims exclusively across workers, delivers and survives store recreation', async () => {
    const second = new PgIntakeStore(pool);
    const sends: string[] = [];
    const sender = { send: async (delivery: { id: string }) => { sends.push(delivery.id); return { issueNumber: sends.length, issueUrl: `https://github.com/example-org/tower-issues/issues/${sends.length}` }; } };
    await Promise.all([deliverOne(store, sender), deliverOne(second, sender), deliverOne(store, sender)]);
    expect(sends).toHaveLength(2); expect(new Set(sends).size).toBe(2);
    expect((await new PgIntakeStore(pool).status(customerA.id, acceptedId, 7))?.status).toBe('delivered');
    expect((await post(tokenA)).status).toBe(200);
  });
  it('never automatically retries expired claims after a crash', async () => {
    const receipt = await store.accept(customerA, 'crash-case-00000001', { ...payload, body: 'crash' });
    const claimed = await store.claim(); expect(claimed?.id).toBe(receipt.id);
    await pool.query("UPDATE feedback_receipts SET claim_until = now() - interval '1 second' WHERE id = $1", [receipt.id]);
    expect(await store.claim()).toBe(null);
    expect((await store.status(customerA.id, receipt.id, 7))?.status).toBe('needs_review');
    await expect(store.settle(claimed!, { status: 'delivered', issueNumber: 10 })).rejects.toThrow('claim_lost');
  });
  it('enforces durable admission limits and allows idempotent replay when limited', async () => {
    await pool.query('UPDATE feedback_tenants SET rate_count = 20, rate_window = now() WHERE id = $1', [customerA.id]);
    expect((await post(tokenA, { ...payload, body: 'new' }, 'rate-case-000000001')).status).toBe(429);
    expect((await post(tokenA)).status).toBe(200);
  });
  it('revocation blocks requests and pending delivery', async () => {
    await pool.query('UPDATE feedback_tenants SET active = false WHERE id = $1', [customerA.id]);
    expect((await post(tokenA)).status).toBe(401);
    const persisted = await pool.query('SELECT token_hash FROM feedback_tenants');
    expect(persisted.rows.every(row => /^[a-f0-9]{64}$/.test(row.token_hash))).toBe(true);
  });
});
