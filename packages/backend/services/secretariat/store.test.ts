import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), transaction: vi.fn(), withClient: (db: any) => db }));
import { query, queryOne, execute, transaction } from '../../db/pg-repo.js';
import { secretariatStore as store } from './store.js';
import fs from 'node:fs';

beforeEach(() => { vi.clearAllMocks(); vi.mocked(query).mockResolvedValue([]); vi.mocked(queryOne).mockResolvedValue(undefined); vi.mocked(execute).mockResolvedValue({ changes: 1 });
  vi.mocked(transaction).mockImplementation(async fn => fn({ query, queryOne, execute }));
});
describe('Secretariat durable SQL contracts', () => {
  it('defaults off without writes', async () => {
    expect(await store.settings(7)).toEqual({ enabled: false }); expect(execute).not.toHaveBeenCalled();
  });
  it('settings invalidate generation without releasing a still-running lease', async () => {
    await store.setEnabled(7, false); const [sql, args] = vi.mocked(execute).mock.calls[0];
    expect(sql).toContain('generation + 1'); expect(sql).not.toContain('claim_token = NULL'); expect(args).toEqual([7, false]);
  });
  it('claim is atomic, owner enabled, eligible, due, unread-free and durable occurrence dedup', async () => {
    vi.mocked(queryOne).mockResolvedValue({ generation: 3 }); expect(await store.claim(7)).toMatchObject({ userId: 7, generation: 3 });
    const [sql, args] = vi.mocked(queryOne).mock.calls[0];
    for (const fragment of ['WITH claimed AS', 'UPDATE secretariat_settings', 'ss.enabled = TRUE', 'ss.next_run_at <= NOW()',
      'claim_until', 'u.disabled = 0', "u.approval_status = 'active'", 'p.read_at IS NULL', 'INSERT INTO secretariat_runs',
      'ON CONFLICT (user_id, occurrence) DO NOTHING', "INTERVAL '1 hour'"]) expect(sql).toContain(fragment);
    expect(args![0]).toBe(7);
  });
  it('excludes unread users from bounded due queue to avoid starvation', async () => {
    await store.dueUsers(); const sql = vi.mocked(query).mock.calls[0][0];
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM secretariat_proposals'); expect(sql).toContain('p.read_at IS NULL');
    expect(sql).toContain('ORDER BY ss.next_run_at LIMIT 3');
  });
  it('defers skipped users without interfering with an active claim', async () => {
    await store.defer(7); const [sql, args] = vi.mocked(execute).mock.calls[0];
    expect(sql).toContain("INTERVAL '1 hour'"); expect(sql).toContain('claim_until < NOW()'); expect(args).toEqual([7]);
  });
  it('returns canonical SQL-generated source key without JS timestamp conversion', async () => {
    vi.mocked(query).mockResolvedValue([{ id: 'w', source_key: 'w:2026-09-21 10:00:00+00', run_title: 'title', outcome: '',
      updated_at: new Date('2026-09-21T10:00:00Z'), session_id: 's', project_id: 'p' }]);
    expect((await store.candidates(7))[0].sourceKey).toBe('w:2026-09-21 10:00:00+00');
    const [sql, args] = vi.mocked(query).mock.calls[0];
    for (const fragment of ['s.user_id = $1', 'recent.last_at::text', 'sp.source_key', 'LIMIT 10', 'authored.username = actor.username', 'agent_workers']) expect(sql).toContain(fragment);
    expect(args).toEqual([7]); expect(sql).toContain("m.role IN ('user','assistant')");
  });
  it('insert rechecks consent/lease/unread and current work freshness before writing', async () => {
    vi.mocked(queryOne).mockResolvedValue({ ok: 1 });
    await store.insert({ userId: 7, token: 'lease', generation: 3 }, { id: 'w', title: 'title', outcome: '', sourceKey: 'w:time', updatedAt: 'time', sessionId: 's', projectId: 'p' }, { title: 'title', body: 'body?' });
    expect(transaction).toHaveBeenCalledOnce();
    expect(vi.mocked(queryOne).mock.calls[0][0]).toContain('FOR UPDATE');
    expect(vi.mocked(queryOne).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(execute).mock.invocationCallOrder[0]);
    const [sql, args] = vi.mocked(execute).mock.calls[0];
    for (const fragment of ['ss.enabled = TRUE', 'ss.generation = $3', 'ss.claim_token = $2', 'ss.claim_until > NOW()',
      'p.read_at IS NULL', 's.user_id = $1', 'MAX(m.created_at)', 'ON CONFLICT DO NOTHING']) expect(sql).toContain(fragment);
    expect(args!.slice(0, 3)).toEqual([7, 'lease', 3]);
  });
  it('owner filters inbox and acknowledgement even for administrators', async () => {
    await store.proposals(7); await store.read(7, 'p');
    expect(vi.mocked(query).mock.calls[0][0]).toContain('WHERE user_id = $1');
    expect(vi.mocked(execute).mock.calls[0]).toEqual([expect.stringContaining('WHERE id = $1 AND user_id = $2'), ['p', 7]]);
  });
  it('migration supplies one unread and source uniqueness and opt-in default off', () => {
    const migration = fs.readFileSync('packages/backend/db/migrations/238_secretariat.sql', 'utf8');
    expect(migration).toContain('DEFAULT FALSE'); expect(migration).toContain('UNIQUE(user_id, occurrence)');
    expect(migration).toContain('UNIQUE(user_id, source_key)'); expect(migration).toContain('WHERE read_at IS NULL');
  });
});

it('extracts visible text only from bounded owner source context', async () => {
  vi.mocked(query).mockResolvedValue([{ role: 'assistant', content: JSON.stringify([
    { type: 'thinking', text: 'private' }, { type: 'tool_result', text: 'tool' },
    { type: 'text', text: 'visible' }, { type: 'text', visibility: 'hidden', text: 'hidden' }]) },
    { role: 'assistant', content: '[{"type":"thinking","text":"truncated' }]);
  expect(await store.context(7, { sessionId: 's', projectId: 'p' } as any)).toEqual([{ role: 'assistant', text: 'visible' }]);
  const [sql,args] = vi.mocked(query).mock.calls[0];
  expect(sql).toContain('s.user_id = $2'); expect(sql).toContain('LIMIT 12'); expect(args).toEqual(['s',7,'p']);
});

it('bounds private secretary history by owner, project and source session', async () => {
  vi.mocked(query).mockResolvedValue([{role:'user',body:'그건 끝났어.'}]);
  const context = await store.secretaryContext(7, {projectId:'p',sessionId:'s'} as any);
  expect(query).toHaveBeenCalledWith(expect.stringContaining('user_id=$1 AND project_id=$2 AND session_id=$3'), [7,'p','s']);
  expect(vi.mocked(query).mock.calls.at(-1)?.[0]).toContain('LIMIT 8');
  expect(context[0].text).toContain('그건 끝났어.');
});
