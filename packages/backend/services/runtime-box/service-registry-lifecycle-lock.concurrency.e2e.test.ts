import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePgPool } from '../../db/pg.js';
import { tryWithRuntimeAdvisoryLocks, withRuntimeAdvisoryLocks } from './runtime-advisory-lock.js';
import { runtimeBoxLifecycleLockKey, withRuntimeBoxLifecycleLock } from './runtime-box-lifecycle-lock.js';

const runFile = promisify(execFile);
const run = process.env.RUNTIME_BOX_SERVICE_LOCK_E2E === '1' ? describe : describe.skip;

async function docker(...args: string[]) {
  return runFile('docker', args, { maxBuffer: 2_000_000 });
}

run('Service lifecycle Box lock concurrency', () => {
  const pgName = `tower-service-lifecycle-lock-pg-${randomBytes(6).toString('hex')}`;
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

  it('serializes writers for the same Box while allowing another Box', async () => {
    let releaseFirst!: () => void;
    let firstHeld!: () => void;
    const held = new Promise<void>(resolve => { firstHeld = resolve; });
    const release = new Promise<void>(resolve => { releaseFirst = resolve; });

    const first = withRuntimeBoxLifecycleLock(101, async () => {
      firstHeld();
      await release;
    });
    await held;

    await expect(tryWithRuntimeAdvisoryLocks(
      [runtimeBoxLifecycleLockKey(101)],
      async () => 'same-box',
    )).resolves.toEqual({ acquired: false });

    await expect(tryWithRuntimeAdvisoryLocks(
      [runtimeBoxLifecycleLockKey(202)],
      async () => 'other-box',
    )).resolves.toEqual({ acquired: true, value: 'other-box' });

    releaseFirst();
    await first;
    await expect(withRuntimeAdvisoryLocks(
      [runtimeBoxLifecycleLockKey(101)],
      async () => 'released',
    )).resolves.toBe('released');
  });
});
