import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePgPool } from '../../db/pg.js';
import { tryWithRuntimeBoxActivityLock, withRuntimeBoxActivityLock } from './runtime-box-activity-lock.js';
import { tryWithRuntimeBoxLifecycleLock, withRuntimeBoxLifecycleLock } from './runtime-box-lifecycle-lock.js';

const runFile = promisify(execFile);
const run = process.env.RUNTIME_BOX_ORDERING_E2E === '1' ? describe : describe.skip;

async function docker(...args: string[]) {
  return runFile('docker', args, { maxBuffer: 2_000_000 });
}

run('Runtime Box A → L ordering concurrency', () => {
  const pgName = `tower-runtime-ordering-pg-${randomBytes(6).toString('hex')}`;
  let previousDatabaseUrl: string | undefined;

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    await docker(
      'run', '-d', '--rm', '--name', pgName,
      '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=tower_test',
      '-p', '127.0.0.1::5432', 'postgres:16-alpine',
    );
    const mapped = await docker('port', pgName, '5432/tcp');
    const port = Number(mapped.stdout.trim().match(/:(\d+)$/)?.[1]);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid mapped PostgreSQL port: ${mapped.stdout}`);
    const url = `postgresql://postgres:test@127.0.0.1:${port}/tower_test`;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await runFile('psql', [url, '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']);
        break;
      } catch {
        if (attempt === 39) throw new Error('Disposable PostgreSQL did not become ready');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    process.env.DATABASE_URL = url;
  }, 120_000);

  afterAll(async () => {
    await closePgPool().catch(() => undefined);
    await docker('rm', '-f', '-v', pgName).catch(() => undefined);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it('an exec-like A holder excludes same-Box destruction but not another Box', async () => {
    let releaseExec!: () => void;
    let execHeld!: () => void;
    const held = new Promise<void>(resolve => { execHeld = resolve; });
    const release = new Promise<void>(resolve => { releaseExec = resolve; });

    const execLike = withRuntimeBoxActivityLock(101, async () => {
      await withRuntimeBoxLifecycleLock(101, async () => undefined);
      execHeld();
      await release;
    });
    await held;

    await expect(tryWithRuntimeBoxActivityLock(101, async activity =>
      withRuntimeBoxLifecycleLock(101, async lifecycle => ({ activity, lifecycle }))
    )).resolves.toEqual({ acquired: false });

    await expect(tryWithRuntimeBoxActivityLock(202, async () =>
      withRuntimeBoxLifecycleLock(202, async () => 'other-box')
    )).resolves.toEqual({ acquired: true, value: 'other-box' });

    releaseExec();
    await execLike;
  });

  it('releases short L while retaining A for the long command window', async () => {
    let releaseExec!: () => void;
    let shortLifecycleReleased!: () => void;
    const lifecycleReleased = new Promise<void>(resolve => { shortLifecycleReleased = resolve; });
    const release = new Promise<void>(resolve => { releaseExec = resolve; });

    const execLike = withRuntimeBoxActivityLock(303, async () => {
      await withRuntimeBoxLifecycleLock(303, async () => undefined);
      shortLifecycleReleased();
      await release;
    });
    await lifecycleReleased;

    await expect(tryWithRuntimeBoxLifecycleLock(303, async () => 'service-writer')).resolves.toEqual({
      acquired: true,
      value: 'service-writer',
    });
    await expect(tryWithRuntimeBoxActivityLock(303, async () => 'destructive')).resolves.toEqual({ acquired: false });

    releaseExec();
    await execLike;
  });
});
