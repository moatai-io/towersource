import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { diagnoseFeedback, feedbackConfigurationSnapshot, type DiagnosticConnection } from './diagnostics.js';

const cli = 'packages/backend/services/feedback-intake/diagnostics-cli.ts';
const env = { DATABASE_URL: 'postgresql://diagnostic:synthetic-private@localhost/tower' };
const metadata = { relkind: 'r', schema_usage: true, can_select: true, can_insert: false,
  can_update: false, can_delete: false, rls_active: false };
const empty = { total: '0', accepted: '0', delivering: '0', delivered: '0', needs_review: '0', failed: '0', other: '0',
  latest_created_at: null, latest_updated_at: null, oldest_pending_at: null };
function fixture(options: { tenants?: object[]; receipts?: object[]; tenantAggregate?: object; receiptAggregate?: object;
  fail?: string; code?: string } = {}) {
  const query = vi.fn(async (sql: string, values?: string[]) => {
    if (options.fail && sql.includes(options.fail)) throw Object.assign(new Error('synthetic-private-provider-error'), { code: options.code });
    if (sql.includes('pg_catalog.pg_class')) return { rows: values?.[0] === 'feedback_tenants' ? options.tenants ?? [metadata] : options.receipts ?? [metadata] };
    if (sql.includes('FROM public.feedback_tenants')) return { rows: [options.tenantAggregate ?? { total: '1', active: '1', inactive: '0' }] };
    if (sql.includes('FROM public.feedback_receipts')) return { rows: [options.receiptAggregate ?? empty] };
    return { rows: [] };
  });
  const db = { query, end: vi.fn(async () => {}) } as DiagnosticConnection;
  return { db, query, connect: vi.fn(async () => db) };
}

describe('feedback aggregate diagnostics', () => {
  it('default-off is a normal response and never connects without explicit DATABASE_URL', async () => {
    const f = fixture(); const result = await diagnoseFeedback({}, f.connect);
    expect(result.flags).toEqual({ client: 'default_off', intake: 'default_off', delivery: 'default_off', candidatePassive: 'default_off' });
    expect(result.database.state).toBe('not_configured'); expect(result.activity.evidence).toBe('unknown');
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('distinguishes invalid and explicit-off flags without treating malformed values as true', () => {
    const result = feedbackConfigurationSnapshot({ TOWER_FEEDBACK_CLIENT_ENABLED: 'TRUE', TOWER_FEEDBACK_INTAKE_ENABLED: 'false', TOWER_FEEDBACK_DELIVERY_ENABLED: 'true' });
    expect(result.flags).toMatchObject({ client: 'invalid', intake: 'off', delivery: 'on' });
    expect(result.effective).toEqual({ clientRouting: 'legacy', intake: 'off', deliveryGate: 'off' });
  });
  it('retains passive guards and labels a delivery gate, not a verified running pump', async () => {
    const result = await diagnoseFeedback({ TOWER_FEEDBACK_INTAKE_ENABLED: 'true', TOWER_FEEDBACK_DELIVERY_ENABLED: 'true', TOWER_CANDIDATE_PASSIVE_MODE: 'true' }, fixture().connect);
    expect(result.effective.intake).toBe('off'); expect(result.effective.deliveryGate).toBe('off');
    expect(result.liveServiceVerified).toBe(false);
  });
  it('does not open signing files and never treats a configured key as verified', () => {
    const result = feedbackConfigurationSnapshot({ TOWER_FEEDBACK_GITHUB_KEY_FILE: '/unreadable/synthetic-private.pem',
      TOWER_FEEDBACK_INTAKE_ENABLED: 'true', TOWER_FEEDBACK_DELIVERY_ENABLED: 'true',
      TOWER_FEEDBACK_GITHUB_APP_ID: '123', TOWER_FEEDBACK_GITHUB_INSTALLATION_ID: '456',
      TOWER_FEEDBACK_GITHUB_REPOSITORY_ID: '789', TOWER_FEEDBACK_GITHUB_REPOSITORY: 'example-org/tower-issues' });
    expect(result.configuration.githubMetadata).toBe('valid');
    expect(result.configuration.signingMaterial).toBe('configured_unverified');
    expect(result.configuration.providerAuthentication).toBe('not_checked');
    expect(JSON.stringify(result)).not.toMatch(/unreadable|synthetic-private|example-org/);
    expect(feedbackConfigurationSnapshot({ TOWER_FEEDBACK_GITHUB_KEY_FILE: '', TOWER_FEEDBACK_GITHUB_PRIVATE_KEY: 'not-a-fallback' }).configuration.signingMaterial).toBe('invalid');
  });
  it('validates client configuration without returning token or origin', () => {
    const result = feedbackConfigurationSnapshot({ TOWER_FEEDBACK_CLIENT_TOKEN: 'a'.repeat(43), TOWER_FEEDBACK_INTAKE_ORIGIN: 'https://feedback.example.com' });
    expect(result.configuration.client).toBe('valid'); expect(JSON.stringify(result)).not.toMatch(/https:|aaaaaaa/);
    expect(feedbackConfigurationSnapshot({ TOWER_FEEDBACK_CLIENT_TOKEN: 'short' }).configuration.client).toBe('invalid');
  });
  it('reports absent tables as normal diagnosis, not zero counts or a deletion recommendation', async () => {
    const f = fixture({ tenants: [], receipts: [] }); const result = await diagnoseFeedback(env, f.connect);
    expect(result.database).toEqual({ state: 'available', tenants: { state: 'missing' }, receipts: { state: 'missing' } });
    expect(result.activity).toEqual({ evidence: 'unknown', pending: null, attention: null, deliveryOffWithPending: null });
  });
  it('distinguishes delivery off from pending receipts and preserves attention states', async () => {
    const date = new Date('2026-01-01T00:00:00Z');
    const f = fixture({ receiptAggregate: { ...empty, total: '7', accepted: '2', delivering: '1', delivered: '1', needs_review: '2', failed: '1',
      latest_created_at: date, latest_updated_at: date, oldest_pending_at: date,
      payload: 'synthetic-private-payload', issue_url: 'https://private.example.com', reporter_user_id: 123 } });
    const result = await diagnoseFeedback(env, f.connect);
    expect(result.activity).toEqual({ evidence: 'receipts_observed', pending: 3, attention: 3, deliveryOffWithPending: true });
    expect(result.database.receipts.oldestPendingAt).toBe('2026-01-01T00:00:00.000Z');
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private|https:|payload|reporter_user_id|issue_url/);
    expect(f.query.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK'); expect(f.db.end).toHaveBeenCalledOnce();
    const sql = f.query.mock.calls.map(([text]) => text).join('\n');
    expect(sql).not.toMatch(/SELECT \*|token_hash|payload|reporter_user_id|issue_url|FOR UPDATE|INSERT INTO|UPDATE public|DELETE FROM|CREATE TABLE/i);
  });
  it('visible empty tables mean no receipts observed, not unused', async () => {
    const result = await diagnoseFeedback(env, fixture().connect);
    expect(result.activity.evidence).toBe('no_receipts_observed'); expect(result.activity.pending).toBe(0);
    expect(result.activity.deliveryOffWithPending).toBe(false);
  });
  it.each([
    ['access_denied', { can_select: false }], ['access_denied', { schema_usage: false }],
    ['row_security_limited', { rls_active: true }], ['unsupported_relation', { relkind: 'v' }],
  ])('does not turn %s into empty counts', async (state, patch) => {
    const f = fixture({ receipts: [{ ...metadata, ...patch as object }] });
    const result = await diagnoseFeedback(env, f.connect);
    expect(result.database.receipts.state).toBe(state); expect(result.activity.evidence).toBe('unknown');
    expect(f.query.mock.calls.some(([sql]) => sql.includes('FROM public.feedback_receipts'))).toBe(false);
  });
  it.each([['42501', 'access_denied'], ['42P01', 'missing'], ['42703', 'schema_mismatch'], ['57014', 'query_failed']])(
    'isolates a failed table query %s and continues to the second table', async (code, state) => {
      const f = fixture({ fail: 'FROM public.feedback_tenants', code });
      const result = await diagnoseFeedback(env, f.connect);
      expect(result.database.tenants.state).toBe(state); expect(result.database.receipts.state).toBe('available');
      expect(f.query.mock.calls.some(([sql]) => sql === 'ROLLBACK TO SAVEPOINT feedback_diagnostics_table')).toBe(true);
      expect(JSON.stringify(result)).not.toContain('synthetic-private');
    });
  it.each([{ total: 'synthetic-secret' }, { latest_updated_at: 'synthetic-secret' }, { total: '9007199254740992' }])(
    'projects and validates unexpected aggregates without echoing arbitrary output', async patch => {
      const result = await diagnoseFeedback(env, fixture({ receiptAggregate: { ...empty, ...patch } }).connect);
      expect(result.database.receipts.state).toBe('query_failed'); expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    });
  it('sanitizes connector failures and allows explicit config-only without connecting', async () => {
    const connect = vi.fn(async () => { throw new Error('postgresql://private:synthetic-secret@private.example.com/db'); });
    const result = await diagnoseFeedback(env, connect);
    expect(result.database.state).toBe('unavailable'); expect(JSON.stringify(result)).not.toMatch(/postgresql:|synthetic-secret/);
    connect.mockClear(); expect((await diagnoseFeedback(env, connect, { database: false })).database.state).toBe('not_requested');
    expect(connect).not.toHaveBeenCalled();
  });
  it('CLI with an explicitly empty environment is default-off and unknown args never echo input', () => {
    const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { env: {}, encoding: 'utf8', timeout: 10000 });
    const result = run([]); expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).flags.intake).toBe('default_off');
    const bad = run(['--synthetic-private']); expect(bad.status).toBe(1); expect(bad.stdout).toBe('');
    expect(bad.stderr).toBe('feedback_diagnostics_failed\n');
  });
});
