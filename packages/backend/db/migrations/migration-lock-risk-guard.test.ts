import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const checker = path.resolve(process.cwd(), 'scripts/check-migration-lock-risks.mjs');

function run(sql: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-migration-lock-guard-'));
  const file = path.join(dir, '160_guard_fixture.sql');
  fs.writeFileSync(file, sql);
  const result = spawnSync(process.execPath, [checker, file], { cwd: process.cwd(), encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

describe('migration lock-risk guard', () => {
  it('rejects lock-sensitive DDL combined with a backfill in one transaction', () => {
    const result = run('ALTER TABLE messages ADD COLUMN message_seq BIGINT;\nUPDATE messages SET message_seq = 1;');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ALTER TABLE + UPDATE/backfill');
  });

  it('accepts split migration steps when each file has one lock class', () => {
    expect(run('ALTER TABLE messages ADD COLUMN message_seq BIGINT;').status).toBe(0);
    expect(run('UPDATE messages SET message_seq = 1 WHERE message_seq IS NULL;').status).toBe(0);
  });

  it('requires an explicit marker for a reviewed exceptional combination', () => {
    const result = run('-- tower:migration-lock-risk-reviewed\nALTER TABLE messages ADD COLUMN x BIGINT;\nUPDATE messages SET x = 1;');
    expect(result.status).toBe(0);
  });

  it('keeps the repository scan clean for post-incident migrations', () => {
    expect(() => execFileSync(process.execPath, [checker], { cwd: process.cwd(), stdio: 'pipe' })).not.toThrow();
  });
});
