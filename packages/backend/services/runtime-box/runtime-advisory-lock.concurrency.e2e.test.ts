import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePgPool } from '../../db/pg.js';
import { tryWithRuntimeAdvisoryLocks, withRuntimeAdvisoryLocks } from './runtime-advisory-lock.js';

const runFile = promisify(execFile);
const run = process.env.RUNTIME_ADVISORY_LOCK_E2E === '1' ? describe : describe.skip;

async function docker(...args: string[]) {
  return runFile('docker', args, { maxBuffer: 2_000_000 });
}

run('runtime advisory lock PostgreSQL E2E', () => {
  const pgName = `tower-runtime-advisory-lock-pg-${randomBytes(6).toString('hex')}`;
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
    await docker('rm', '-f', pgName).catch(() => undefined);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it('serializes the same key but not unrelated keys', async () => {
    let releaseFirst!: () => void;
    let firstHeld!: () => void;
    const held = new Promise<void>(resolve => { firstHeld = resolve; });
    const release = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = withRuntimeAdvisoryLocks(['box:1'], async () => {
      firstHeld();
      await release;
    });
    await held;

    await expect(tryWithRuntimeAdvisoryLocks(['box:1'], async () => 'same')).resolves.toEqual({ acquired: false });
    await expect(tryWithRuntimeAdvisoryLocks(['box:2'], async () => 'other')).resolves.toEqual({ acquired: true, value: 'other' });

    releaseFirst();
    await first;
    await expect(tryWithRuntimeAdvisoryLocks(['box:1'], async () => 'released')).resolves.toEqual({ acquired: true, value: 'released' });
  });

  it('releases a lock after callback failure', async () => {
    await expect(withRuntimeAdvisoryLocks(['failure:key'], async () => {
      throw new Error('fixture failure');
    })).rejects.toThrow('fixture failure');

    await expect(tryWithRuntimeAdvisoryLocks(['failure:key'], async () => 9)).resolves.toEqual({ acquired: true, value: 9 });
  });
});
