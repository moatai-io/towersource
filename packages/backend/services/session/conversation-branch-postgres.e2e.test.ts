import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const runFile = promisify(execFile);
const run = process.env.CONVERSATION_BRANCH_PG_E2E === '1' ? describe : describe.skip;
async function docker(...args: string[]) { return runFile('docker', args, { maxBuffer: 2_000_000 }); }

vi.mock('../../engines/index.js', () => ({ getAllRunningSessionIds: () => [] }));
vi.mock('../../engines/pi/rehydrate.js', () => ({ rehydratePiSessionFromMessages: vi.fn(async () => '/tmp/branch.jsonl') }));

run('conversation branch disposable PostgreSQL vertical slice', () => {
  const suffix = randomBytes(5).toString('hex');
  const pgName = `tower-conversation-branch-pg-${suffix}`;
  const sourceSessionId = `source-${suffix}`;
  const userId = 93;
  let projectRoot = '';
  let previousDatabaseUrl: string | undefined;
  let modules: any;

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    projectRoot = await mkdtemp(path.join(os.tmpdir(), 'tower-conversation-branch-e2e-'));
    await docker('run', '-d', '--rm', '--name', pgName,
      '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=tower_test',
      '-p', '127.0.0.1::5432', 'postgres:16-alpine');
    const mapped = await docker('port', pgName, '5432/tcp');
    const port = Number(mapped.stdout.trim().match(/:(\d+)$/)?.[1]);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid PostgreSQL port: ${mapped.stdout}`);
    const databaseUrl = `postgresql://postgres:test@127.0.0.1:${port}/tower_test`;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']); break; }
      catch { if (attempt === 39) throw new Error('Disposable PostgreSQL did not become ready'); await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    process.env.DATABASE_URL = databaseUrl;
    const migrationRoot = path.resolve(process.cwd(), 'packages/backend/db/migrations');
    for (const file of ['007_users.sql', '008_sessions.sql', '009_projects.sql', '012_session_source_message.sql', '013_session_parent.sql', '016_message_username.sql', '018_claude_accounts.sql', '018_session_labels.sql', '053_session_config_dir.sql', '055_messages_metadata.sql', '059_engine_switch_history.sql', '067_sessions_short_code.sql', '069_messages_short_id.sql', '085_message_time_lifecycle.sql', '120_agent_harness_registry.sql', '129_harness_prompt_bundle_fingerprint.sql', '159_messages_message_seq.sql', '159_messages_message_seq_2_backfill.sql', '159_messages_message_seq_3_notnull.sql', '159_messages_message_seq_4_index.sql']) {
      await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', path.join(migrationRoot, file)]);
    }
    modules = {
      db: await import('../../db/pg-repo.js'),
      pg: await import('../../db/pg.js'),
      branch: await import('./conversation-branch.js'),
    };
    await modules.db.execute(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pi_session_file TEXT, ADD COLUMN IF NOT EXISTS agent_creation_command_id TEXT`);
    await modules.db.execute(`CREATE TABLE IF NOT EXISTS agent_workers(id TEXT PRIMARY KEY, backing_session_id TEXT, name TEXT, role TEXT, visibility TEXT, status TEXT, kind TEXT, metadata JSONB NOT NULL DEFAULT '{}'::jsonb)`);
    await modules.db.execute(`INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,'x','admin')`, [userId, `branch-${suffix}`]);
    await modules.db.execute(
      `INSERT INTO sessions(id,short_code,name,cwd,user_id,engine,visibility,model_used)
       VALUES($1,'brnch001','Branch source',$2,$3,'pi','project','litellm-responses/smartest')`,
      [sourceSessionId, projectRoot, userId],
    );
    const sameTime = '2026-08-03T10:00:00.000Z';
    for (const [id, role, text] of [
      ['z-user-1', 'user', '첫 요청'],
      ['a-assistant-1', 'assistant', '첫 답변'],
      ['m-user-2', 'user', '수정할 요청'],
      ['b-assistant-2', 'assistant', '제외할 답변'],
    ]) {
      await modules.db.execute(
        `INSERT INTO messages(id,session_id,role,content,created_at) VALUES($1,$2,$3,$4,$5)`,
        [id, sourceSessionId, role, JSON.stringify([{ type: 'text', text }]), sameTime],
      );
    }
  }, 120_000);

  afterAll(async () => {
    await modules?.pg?.closePgPool().catch(() => undefined);
    await docker('rm', '-f', pgName).catch(() => undefined);
    if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it('uses message_seq, not UUID or timestamp ties, for edit-and-resend', async () => {
    const result = await modules.branch.branchConversation({
      sourceSessionId, sourceMessageId: 'm-user-2', actorUserId: userId, mode: 'edit_and_resend',
    });
    expect(result.draft).toBe('수정할 요청');
    expect(result.session.name).toBe('Branch source (과거에서 다시 시작)');
    expect(result.session.visibility).toBe('project');
    expect(result.session.parentSessionId).toBe(sourceSessionId);
    expect(result.session.sourceMessageId).toBe('m-user-2');
    const child = await modules.db.query(`SELECT role,content FROM messages WHERE session_id=$1 ORDER BY message_seq`, [result.session.id]);
    expect(child.map((row: any) => JSON.parse(row.content)[0].text)).toEqual(['첫 요청', '첫 답변']);
    expect(await modules.db.queryOne(`SELECT count(*)::int AS count FROM messages WHERE session_id=$1`, [sourceSessionId])).toEqual({ count: 4 });
  }, 120_000);

  it('returns the selected user request for replay and copies only its prior prefix', async () => {
    const result = await modules.branch.branchConversation({
      sourceSessionId, sourceMessageId: 'm-user-2', actorUserId: userId, mode: 'clone_through',
    });
    expect(result.draft).toBe('');
    expect(result.replayPrompt).toBe('수정할 요청');
    const child = await modules.db.query(`SELECT role,content FROM messages WHERE session_id=$1 ORDER BY message_seq`, [result.session.id]);
    expect(child.map((row: any) => JSON.parse(row.content)[0].text)).toEqual(['첫 요청', '첫 답변']);
  }, 120_000);
});
