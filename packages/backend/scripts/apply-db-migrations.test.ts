import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => ({ query: vi.fn(), init: vi.fn(), enabled: vi.fn() }));
vi.mock('../db/pg.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/pg.js')>()),
  getPgPool: () => ({ query: pg.query }),
  initPg: pg.init,
  isPgEnabled: pg.enabled,
}));

import { runMigrationCommand } from './apply-db-migrations.js';

let output: ReturnType<typeof vi.spyOn>;
function report() { return JSON.parse(output.mock.calls.at(-1)![0] as string); }
function history(rows: Array<{ version: string; name: string | null }>, exists = true) {
  pg.query.mockResolvedValueOnce({ rows: [{ exists }] });
  if (exists) pg.query.mockResolvedValueOnce({ rows });
}

beforeEach(() => {
  pg.query.mockReset();
  pg.init.mockReset().mockResolvedValue(undefined);
  pg.enabled.mockReturnValue(true);
  vi.stubEnv('TOWER_ROLE', 'full');
  vi.stubEnv('TOWER_TURN_REWIND_ENABLED', 'true');
  vi.spyOn(fs, 'readdirSync').mockReturnValue(['001_first.sql', '002_second.sql'] as any);
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('migration command', () => {
  it('status only reads history and reports all files when the table is absent', async () => {
    history([], false);
    await runMigrationCommand(['status']);
    expect(report()).toMatchObject({ status: 'ok', pendingCount: 2 });
    expect(pg.init).not.toHaveBeenCalled();
    expect(pg.query).toHaveBeenCalledTimes(1);
    expect(pg.query.mock.calls[0][0]).toMatch(/^SELECT /);
  });

  it('apply queries history after init and reports verified completion', async () => {
    pg.init.mockImplementation(async () => { expect(pg.query).not.toHaveBeenCalled(); });
    history([{ version: '001', name: '001_first.sql' }, { version: '002_second', name: '002_second.sql' }]);
    await runMigrationCommand(['apply']);
    expect(report()).toMatchObject({ status: 'migrated', pending: [], pendingCount: 0, applied: ['001', '002_second'] });
    expect(pg.query.mock.calls[1][0]).toBe('SELECT version, name FROM _migrations ORDER BY version');
  });

  it('apply refuses success when init returns but history still has pending files', async () => {
    history([{ version: '001_first', name: '001_first.sql' }]);
    await expect(runMigrationCommand(['apply'])).rejects.toThrow('1 pending migration(s) remain');
    expect(report()).toMatchObject({ status: 'incomplete', pending: ['002_second.sql'], pendingCount: 1 });
  });

  it('apply refuses success if the history table is still absent', async () => {
    history([], false);
    await expect(runMigrationCommand(['apply'])).rejects.toThrow('2 pending migration(s) remain');
    expect(report().status).toBe('incomplete');
  });

  it('reports explicit deferrals without changing runner policy', async () => {
    vi.stubEnv('TOWER_ROLE', 'managed');
    vi.stubEnv('TOWER_TURN_REWIND_ENABLED', 'false');
    vi.mocked(fs.readdirSync).mockReturnValue(['158_turn_file_checkpoints.sql'] as any);
    history([]);
    await runMigrationCommand(['apply']);
    expect(report()).toMatchObject({ status: 'migrated', pendingCount: 0, deferredCount: 1 });
  });

  it('compares a candidate SQL manifest to database history without running init', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue('["018_new.sql", "018_old.sql", "018_new.sql"]');
    history([{ version: '018_old', name: '018_old.sql' }]);
    await runMigrationCommand(['status', '--files-json', '/candidate.json']);
    expect(report().pending).toEqual(['018_new.sql']);
    expect(fs.readdirSync).not.toHaveBeenCalled();
    expect(pg.init).not.toHaveBeenCalled();
  });

  it.each(['{}', '[42]', '["../001.sql"]', '["sub/001.sql"]', '["sub\\\\001.sql"]', '["README.md"]'])('rejects invalid manifests before DB access: %s', async (json) => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(json);
    await expect(runMigrationCommand(['status', '--files-json', '/candidate.json'])).rejects.toThrow('SQL file basenames');
    expect(pg.query).not.toHaveBeenCalled();
  });

  it.each([['apply', '--files-json', '/candidate.json'], ['status', '--files-json'], ['bogus'], ['status', '--extra']])('rejects invalid arguments: %j', async (...args) => {
    await expect(runMigrationCommand(args)).rejects.toThrow('usage:');
    expect(pg.init).not.toHaveBeenCalled();
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('fails before init when migration build assets are missing', async () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('ENOENT'); });
    await expect(runMigrationCommand(['apply'])).rejects.toThrow('ENOENT');
    expect(pg.init).not.toHaveBeenCalled();
  });

  it('does not emit a success report after initialization failure', async () => {
    pg.init.mockRejectedValue(new Error('migration rolled back'));
    await expect(runMigrationCommand(['apply'])).rejects.toThrow('migration rolled back');
    expect(output).not.toHaveBeenCalled();
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('does not emit a success report when requery fails', async () => {
    pg.query.mockRejectedValue(new Error('query failed'));
    await expect(runMigrationCommand(['apply'])).rejects.toThrow('query failed');
    expect(output).not.toHaveBeenCalled();
  });

  it('requires a configured database for apply instead of allowing init to no-op', async () => {
    pg.enabled.mockReturnValue(false);
    await expect(runMigrationCommand(['apply'])).rejects.toThrow('DATABASE_URL is not set');
    expect(pg.init).not.toHaveBeenCalled();
  });
});
