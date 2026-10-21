import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBashObservations } from './bash-observations.mjs';
test('separates temporal candidates and cross-session overlaps; malformed evidence fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bash-evidence-'));
  const file = join(dir, 'ledger');
  try {
    writeFileSync(file, [{ version: 1, sessionId: 'a', complete: true, paths: ['one.ts', 'both.ts', '../escape'] }, { version: 1, sessionId: 'b', complete: true, paths: ['both.ts'] }].map(JSON.stringify).join('\n'));
    assert.deepEqual(readBashObservations(file, 'a'), { status: 'ok', candidates: ['both.ts', 'one.ts'], conflicts: ['both.ts'] });
    writeFileSync(file, '{broken');
    assert.equal(readBashObservations(file, 'a').status, 'unavailable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
