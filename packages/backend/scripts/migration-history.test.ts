import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  rows: [] as Array<{ version: string; name?: string | null }>,
  inserted: [] as string[],
}));

// Exercise the real runner with a disposable in-memory query double. No pg
// socket can be created, and SQL file contents are never executed.
vi.mock('pg', () => ({
  Pool: class {
    on = vi.fn();
    end = vi.fn();
    query = vi.fn(async (sql: string) => {
      if (sql === 'SELECT NOW()') return { rows: [{ now: '2026-01-01T00:00:00Z' }] };
      if (sql === 'SELECT version, name FROM _migrations') return { rows: database.rows };
      return { rows: [] };
    });
    connect = vi.fn(async () => ({
      query: vi.fn(async (sql: string, values?: string[]) => {
        if (sql.startsWith('INSERT INTO _migrations')) database.inserted.push(values![1]);
        return { rows: [] };
      }),
      release: vi.fn(),
    }));
  },
}));

import { closePgPool, initPg } from '../db/pg.js';
import { compareMigrationHistory, type MigrationHistoryRow } from './migration-history.js';

const files = ['018_alpha.sql', '018_beta.sql', '019_gamma.sql', '158_turn_file_checkpoints.sql', '159_messages_message_seq.sql'];

beforeEach(() => {
  database.rows = [];
  database.inserted = [];
  vi.stubEnv('DATABASE_URL', 'postgresql://disposable.invalid/test');
  vi.stubEnv('TOWER_ROLE', 'full');
  vi.stubEnv('TOWER_TURN_REWIND_ENABLED', 'true');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await closePgPool();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('migration history identity comparison', () => {
  it.each<[string, MigrationHistoryRow[]]>([
    ['empty history', []],
    ['full version', [{ version: '018_alpha', name: null }]],
    ['filename name', [{ version: 'retired-key', name: '018_alpha.sql' }]],
    ['extensionless name', [{ version: 'retired-key', name: '018_alpha' }]],
    ['legacy prefix covers both same-prefix files', [{ version: '018', name: '018_alpha.sql' }]],
    ['legacy prefix stored in name', [{ version: 'old', name: '018' }]],
    ['version is not extension-stripped by the runner', [{ version: '018_alpha.sql', name: null }]],
  ])('agrees with the real runner: %s', async (_label, rows) => {
    database.rows = rows;
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(files as any);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('SELECT 1;');
    const comparison = compareMigrationHistory(files, rows);
    await initPg();
    expect(database.inserted).toEqual(comparison.pending);
  });

  it('keeps runner deferral separate from actionable pending migrations', async () => {
    vi.stubEnv('TOWER_ROLE', 'managed');
    vi.stubEnv('TOWER_TURN_REWIND_ENABLED', 'false');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(files as any);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('SELECT 1;');
    const comparison = compareMigrationHistory(files, []);
    await initPg();
    expect(database.inserted).toEqual(comparison.pending);
    expect(comparison.deferred).toEqual(files.slice(3));
    expect(comparison.pendingCount).toBe(3);
    expect(comparison.deferredCount).toBe(2);
  });

  it('does not list already-applied files as deferred', () => {
    const comparison = compareMigrationHistory(files, [{ version: '158', name: null }], {
      TOWER_ROLE: 'managed', TOWER_TURN_REWIND_ENABLED: 'false',
    });
    expect(comparison.deferred).toEqual(['159_messages_message_seq.sql']);
  });

  it('reports ambiguous legacy matches and unmatched history without claiming content validation', () => {
    const missing = { version: '017_removed', name: '017_removed.sql' };
    const comparison = compareMigrationHistory(files, [missing, { version: '018', name: '018_alpha.sql' }]);
    expect(comparison.legacyPrefixMatches).toEqual(['018_beta.sql']);
    expect(comparison.unmatchedApplied).toEqual([missing]);
    expect(comparison.contentVerification).toBe('unavailable-no-stored-checksum');
  });

  it('sorts SQL candidates and ignores non-SQL files', () => {
    expect(compareMigrationHistory(['b.sql', 'README.md', 'a.sql'], []).pending).toEqual(['a.sql', 'b.sql']);
  });
});
