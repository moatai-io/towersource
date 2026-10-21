import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { utcUsageWindow, usageSeries } from './usage-period.js';

const api = fs.readFileSync(path.resolve(import.meta.dirname, '../../routes/api.ts'), 'utf8');
const start = api.indexOf("router.get('/metrics/my-ai-usage'");
const end = api.indexOf('// ───── Sessions', start);
const routeSource = api.slice(start, end);
const now = new Date('2026-09-23T16:37:00Z');
const pgBin = [process.env.USAGE_TEST_PG_BIN, '/usr/lib/postgresql/18/bin', '/usr/lib/postgresql/14/bin']
  .find((dir) => dir && fs.existsSync(path.join(dir, 'initdb')));
const canRunPostgres = !!pgBin && process.getuid?.() !== 0;

describe('usage route source contracts', () => {
  it('keeps owner/project-member ACL and replaces lifetime and rolling windows', () => {
    expect(routeSource).toContain('WHERE s.user_id = $1');
    expect(routeSource).toContain('pm.project_id = p.id AND pm.user_id = $1');
    expect(routeSource).toContain("m.content LIKE '[{\"type\":\"text\"%'");
    expect(routeSource).not.toMatch(/updated_at|session-estimate|NOW\(\)|SUM\(total_tokens\)|SUM\(turn_count\)/);
    expect(routeSource).toContain('m.created_at < $3::timestamptz');
    expect(routeSource).toContain("AT TIME ZONE 'UTC'");
    expect(routeSource).toContain('grandTotal: allSeries.total, dailyTotals: allSeries.values');
  });
});

// Execute the actual route bodies + SQL against a disposable local PostgreSQL.
// No production connection string, config, middleware, or shared database is loaded.
describe.skipIf(!canRunPostgres)('usage routes with numeric PostgreSQL fixtures', () => {
  let root: string;
  let client: Client;
  let running = false;
  const handlers = new Map<string, (req: any, res: any) => Promise<void>>();
  const command = (name: string, args: string[]) => execFileSync(path.join(pgBin!, name), args, { stdio: 'pipe', timeout: 20_000 });

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-usage-fixture-'));
    command('initdb', ['-D', path.join(root, 'db'), '-A', 'trust', '-U', 'fixture', '--no-locale', '-E', 'UTF8']);
    command('pg_ctl', ['-D', path.join(root, 'db'), '-l', path.join(root, 'postgres.log'), '-o', `-F -k ${root} -c listen_addresses=''`, '-w', 'start']);
    running = true;
    client = new Client({ host: root, user: 'fixture', database: 'postgres', port: 5432 });
    await client.connect();
    await client.query(`
      CREATE TABLE projects (id text PRIMARY KEY, name text, user_id integer, archived integer);
      CREATE TABLE project_members (project_id text, user_id integer);
      CREATE TABLE sessions (id text PRIMARY KEY, project_id text, user_id integer, updated_at timestamptz,
        turn_count integer DEFAULT 9999, total_tokens integer DEFAULT 9999999, total_cost numeric DEFAULT 9999);
      CREATE TABLE messages (id serial, session_id text, role text, content text, created_at timestamptz,
        input_tokens integer, output_tokens integer, metadata jsonb DEFAULT '{}');
    `);
    const query = async (sql: string, params?: any[]) => (await client.query(sql, params)).rows;
    const queryOne = async (sql: string, params?: any[]) => (await query(sql, params))[0];
    const js = ts.transpileModule(routeSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function('router', 'query', 'queryOne', 'utcUsageWindow', 'usageSeries', 'cachedUsageMetrics', js)(
      { get: (route: string, handler: any) => handlers.set(route, handler) },
      query, queryOne, (days: number) => utcUsageWindow(days, now), usageSeries,
      (_key: string, compute: () => Promise<unknown>) => compute(),
    );
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    if (running) command('pg_ctl', ['-D', path.join(root, 'db'), '-m', 'fast', '-w', 'stop']);
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE messages, sessions, project_members, projects;
      SET TIME ZONE 'Asia/Seoul';
      INSERT INTO projects VALUES ('owned', 'Owned', 1, 0), ('shared', 'Shared', 2, 0),
        ('denied', 'Denied', 2, 0), ('archived', 'Archived', 1, 1);
      INSERT INTO project_members VALUES ('shared', 1);
      INSERT INTO sessions(id, project_id, user_id, updated_at) VALUES
        ('old', 'owned', 1, '2026-09-23T12:00:00Z'),
        ('other-owner', 'owned', 2, '2026-09-23T12:00:00Z'),
        ('shared-session', 'shared', 2, '2026-09-23T12:00:00Z'),
        ('denied-session', 'denied', 2, '2026-09-23T12:00:00Z'),
        ('archived-session', 'archived', 1, '2026-09-23T12:00:00Z'),
        ('empty', 'owned', 1, '2026-09-23T12:00:00Z');`);
  });

  async function message(session: string, date: string, role = 'user', input = 0, output = 0, cost?: number, content = '[{"type":"text","text":"fixture"}]') {
    await client.query(`INSERT INTO messages(session_id, created_at, role, input_tokens, output_tokens, metadata, content)
      VALUES ($1, $2::timestamptz, $3, $4, $5, $6::jsonb, $7)`,
    [session, date, role, input, output, JSON.stringify(cost === undefined ? {} : { usage: { cost_usd: cost } }), content]);
  }
  async function call(route: string, query: Record<string, string> = { days: '3' }, userId: number | undefined = 1) {
    let result: any;
    let status = 200;
    await handlers.get(route)!({ user: { userId }, query }, {
      status: (code: number) => { status = code; return { json: (body: any) => { result = body; } }; },
      json: (body: any) => { result = body; },
    });
    expect(status, JSON.stringify(result)).toBe(200);
    return result;
  }

  it('excludes old lifetime totals, start-minus-1ms and next midnight; uses message totals and UTC dates', async () => {
    await message('old', '2026-09-20T23:59:59.999Z', 'assistant', 90000, 90000, 100);
    await message('old', '2026-09-21T00:00:00Z');
    await message('old', '2026-09-21T00:00:01Z', 'assistant', 100, 20, 0.25);
    await message('old', '2026-09-23T23:59:59.999Z');
    await message('old', '2026-09-23T23:59:59.999Z', 'assistant', 200, 40, 0.5);
    await message('old', '2026-09-24T00:00:00Z', 'assistant', 90000, 90000, 100);
    await message('other-owner', '2026-09-22T12:00:00Z', 'assistant', 90000, 90000, 100);
    const result = await call('/metrics/my-ai-usage');
    expect(result.dates).toEqual(['2026-09-21', '2026-09-22', '2026-09-23']);
    expect(result.totals).toEqual({ sessions: 1, turns: 2, totalTokens: 360, costUsd: 0.75 });
    expect(result.daily.map((r: any) => r.date)).toEqual(['2026-09-21', '2026-09-23']);
    expect(result.projects[0]).toMatchObject({ total: 2, values: [1, 0, 1] });
    expect(result.costBasis).toBe('message-provider-metadata');
    expect(result.costAvailable).toBe(true);
    await client.query("SET TIME ZONE 'America/Los_Angeles'");
    expect(await call('/metrics/my-ai-usage')).toEqual(result);
  });

  it('distinguishes unavailable metadata from a real zero without session-cost fallback', async () => {
    await message('old', '2026-09-22T12:00:00Z');
    let result = await call('/metrics/my-ai-usage');
    expect(result.costAvailable).toBe(false);
    expect(result.totals.costUsd).toBe(0);
    await message('old', '2026-09-22T12:00:01Z', 'assistant', 50, 10, 0);
    result = await call('/metrics/my-ai-usage');
    expect(result.costAvailable).toBe(true);
    expect(result.totals).toEqual({ sessions: 1, turns: 1, totalTokens: 60, costUsd: 0 });
  });

  it('keeps all-project totals independent of top N, user-only active days, ACL, and legacy content filter', async () => {
    await message('old', '2026-09-20T23:59:59.999Z');
    await message('old', '2026-09-21T00:00:00Z');
    await message('other-owner', '2026-09-21T01:00:00Z');
    await message('old', '2026-09-22T12:00:00Z', 'assistant');
    await message('old', '2026-09-22T12:00:00Z', 'user', 0, 0, undefined, 'plain text excluded by legacy filter');
    await message('old', '2026-09-23T23:59:59.999Z');
    await message('old', '2026-09-24T00:00:00Z');
    await message('shared-session', '2026-09-22T12:00:00Z');
    await message('denied-session', '2026-09-22T12:00:00Z');
    await message('archived-session', '2026-09-22T12:00:00Z');
    const result = await call('/metrics/usage-heatmap', { days: '3', top: '1' });
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toEqual({ id: 'owned', name: 'Owned', sessions: 2, total: 3, activeDays: 2, values: [2, 0, 1] });
    expect(result.dailyTotals).toEqual([2, 1, 1]);
    expect(result.grandTotal).toBe(4);
    const more = await call('/metrics/usage-heatmap', { days: '3', top: '20' });
    expect(more.projects).toHaveLength(2);
    expect(more.grandTotal).toBe(result.grandTotal);
    expect(more.dailyTotals).toEqual(result.dailyTotals);
    await client.query("SET TIME ZONE 'America/Los_Angeles'");
    expect(await call('/metrics/usage-heatmap', { days: '3', top: '1' })).toEqual(result);
  });

  it('returns a full zero axis for empty activity', async () => {
    const result = await call('/metrics/usage-heatmap');
    expect(result).toEqual({ days: 3, topN: 20, dates: ['2026-09-21', '2026-09-22', '2026-09-23'], projects: [], grandTotal: 0, dailyTotals: [0, 0, 0] });
  });
});
