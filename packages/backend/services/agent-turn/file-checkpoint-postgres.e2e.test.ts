import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runFile = promisify(execFile);
const run = process.env.TURN_CHECKPOINT_PG_E2E === '1' ? describe : describe.skip;
async function docker(...args: string[]) { return runFile('docker', args, { maxBuffer: 2_000_000 }); }

run('turn checkpoint disposable PostgreSQL vertical slice', () => {
  const suffix = randomBytes(5).toString('hex');
  const pgName = `tower-turn-checkpoint-pg-${suffix}`;
  const sessionId = `checkpoint-session-${suffix}`;
  const rootTurnId = `checkpoint-turn-${suffix}`;
  const userId = 92;
  let databaseUrl = '';
  let projectRoot = '';
  let previousDatabaseUrl: string | undefined;
  let modules: any;

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    projectRoot = await mkdtemp(path.join(os.tmpdir(), 'tower-checkpoint-e2e-'));
    await docker('run', '-d', '--rm', '--name', pgName,
      '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=tower_test',
      '-p', '127.0.0.1::5432', 'postgres:16-alpine');
    const mapped = await docker('port', pgName, '5432/tcp');
    const port = Number(mapped.stdout.trim().match(/:(\d+)$/)?.[1]);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid mapped PostgreSQL port: ${mapped.stdout}`);
    databaseUrl = `postgresql://postgres:test@127.0.0.1:${port}/tower_test`;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']); break; }
      catch { if (attempt === 39) throw new Error('Disposable PostgreSQL did not become ready'); await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    process.env.DATABASE_URL = databaseUrl;
    const migrationRoot = path.resolve(process.cwd(), 'packages/backend/db/migrations');
    for (const file of ['007_users.sql', '008_sessions.sql', '138_agent_turns.sql', '155_agent_turn_safe_stop.sql', '158_turn_file_checkpoints.sql']) {
      await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', path.join(migrationRoot, file)]);
    }
    modules = {
      db: await import('../../db/pg-repo.js'),
      pg: await import('../../db/pg.js'),
      repo: await import('./file-checkpoint-repo.js'),
      file: await import('./file-checkpoint.js'),
      preview: await import('./file-checkpoint-preview.js'),
      restore: await import('./file-checkpoint-restore.js'),
    };
    await modules.db.execute(`INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,'x','admin')`, [userId, `checkpoint-${suffix}`]);
    await modules.db.execute(`INSERT INTO sessions(id,name,cwd,user_id,engine) VALUES($1,'Checkpoint E2E',$2,$3,'pi')`, [sessionId, projectRoot, userId]);
    await modules.db.execute(`INSERT INTO messages(id,session_id,role,content) VALUES($1,$2,'user','checkpoint')`, [rootTurnId, sessionId]);
    await modules.db.execute(`INSERT INTO agent_turns(root_turn_id,session_id,state) VALUES($1,$2,'completed')`, [rootTurnId, sessionId]);
  }, 120_000);

  afterAll(async () => {
    await modules?.pg?.closePgPool().catch(() => undefined);
    await docker('rm', '-f', pgName).catch(() => undefined);
    if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it('captures first-before/last-after, previews, restores, and appends audit rows', async () => {
    const filePath = path.join(projectRoot, 'notes.md');
    await writeFile(filePath, 'before');
    const before = await modules.file.snapshotFile(projectRoot, filePath);
    await writeFile(filePath, 'after-one');
    const afterOne = await modules.file.snapshotFile(projectRoot, filePath);
    const checkpointId = await modules.repo.ensureTurnCheckpoint({ rootTurnId, sessionId });
    await modules.repo.recordCheckpointFileChange({ checkpointId, filePath, toolName: 'write', before, after: afterOne });

    await writeFile(filePath, 'after-two');
    const afterTwo = await modules.file.snapshotFile(projectRoot, filePath);
    await modules.repo.recordCheckpointFileChange({ checkpointId, filePath, toolName: 'edit', before: afterOne, after: afterTwo });
    await modules.repo.ensureTurnCheckpoint({ rootTurnId, sessionId, partial: true });

    const stored = await modules.repo.loadCheckpointFileChanges(checkpointId);
    expect(stored).toHaveLength(1);
    expect(stored[0].before.content.toString()).toBe('before');
    expect(stored[0].after.content.toString()).toBe('after-two');
    expect((await modules.repo.getTurnCheckpoint({ rootTurnId, sessionId })).coverage).toBe('partial');

    const preview = await modules.preview.previewCheckpointRestore({ checkpointId, projectRoot, requestedBy: userId });
    expect(preview.canApply).toBe(true);
    const applied = await modules.restore.applyConfirmedCheckpointRestore({ checkpointId, projectRoot, requestedBy: userId, previewHash: preview.previewHash, confirmed: true });
    expect(applied.restoredPaths).toEqual([filePath]);
    expect(await readFile(filePath, 'utf8')).toBe('before');

    const audit = await modules.db.query<{ status: string; preview_hash: string }>(
      `SELECT status,preview_hash FROM checkpoint_restore_runs WHERE checkpoint_id=$1 ORDER BY created_at,id`, [checkpointId],
    );
    expect(audit.map((row: any) => row.status)).toEqual(['previewed', 'applied']);
    expect(audit.every((row: any) => row.preview_hash === preview.previewHash)).toBe(true);
  }, 120_000);

  it('rejects a stale preview after an intervening file change and audits conflict', async () => {
    const checkpoint = await modules.repo.getTurnCheckpoint({ rootTurnId, sessionId });
    const filePath = path.join(projectRoot, 'notes.md');
    await writeFile(filePath, 'after-two');
    const preview = await modules.preview.previewCheckpointRestore({ checkpointId: checkpoint.id, projectRoot, requestedBy: userId });
    await writeFile(filePath, 'user-change');
    await expect(modules.restore.applyConfirmedCheckpointRestore({ checkpointId: checkpoint.id, projectRoot, requestedBy: userId, previewHash: preview.previewHash, confirmed: true })).rejects.toThrow('checkpoint_preview_stale');
    expect(await readFile(filePath, 'utf8')).toBe('user-change');
    const latest = await modules.db.queryOne<{ status: string; error: string }>(`SELECT status,error FROM checkpoint_restore_runs WHERE checkpoint_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`, [checkpoint.id]);
    expect(latest).toEqual({ status: 'conflict', error: 'checkpoint_preview_stale' });
  }, 120_000);
});
