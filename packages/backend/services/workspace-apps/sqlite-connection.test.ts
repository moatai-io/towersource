import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWorkspaceAppSqliteReadOnlyQuery, resolveWorkspaceAppSqliteDatabasePath } from './sqlite-connection.js';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-workspace-apps-sqlite-'));
  fs.mkdirSync(path.join(root, 'apps', 'sales-ops'), { recursive: true });
});

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function createDb(relativePath = 'apps/sales-ops/data.sqlite') {
  const dbPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(path.join(root, 'seed.sql'), `
CREATE TABLE accounts (name TEXT, owner TEXT, status TEXT, sort_order INTEGER);
INSERT INTO accounts VALUES ('DemoOrg', 'Julius', '갱신 협의', 1);
INSERT INTO accounts VALUES ('Moat Builders', 'AI Team', '청구 완료', 2);
`, 'utf8');
  const child = spawnSync('sqlite3', [dbPath], { input: fs.readFileSync(path.join(root, 'seed.sql')), encoding: 'utf8' });
  if (child.status !== 0) throw new Error(child.stderr || 'sqlite seed failed');
}

describe('Workspace Apps SQLite connection', () => {
  it('runs project-local SQLite queries in readonly mode', async () => {
    createDb();
    const result = await runWorkspaceAppSqliteReadOnlyQuery({
      projectRoot: root,
      databasePath: 'apps/sales-ops/data.sqlite',
      sql: 'SELECT name, owner, status FROM accounts ORDER BY sort_order',
    });
    expect(result.columns).toEqual(['name', 'owner', 'status']);
    expect(result.rows).toEqual([
      { name: 'DemoOrg', owner: 'Julius', status: '갱신 협의' },
      { name: 'Moat Builders', owner: 'AI Team', status: '청구 완료' },
    ]);
  });

  it('rejects absolute, escaping, non-sqlite, and symlink-escaping database paths', () => {
    createDb();
    expect(() => resolveWorkspaceAppSqliteDatabasePath({ projectRoot: root, databasePath: '/tmp/outside.sqlite' })).toThrow('project-relative');
    expect(() => resolveWorkspaceAppSqliteDatabasePath({ projectRoot: root, databasePath: '../outside.sqlite' })).toThrow('project root');
    fs.writeFileSync(path.join(root, 'apps', 'sales-ops', 'data.txt'), 'not sqlite');
    expect(() => resolveWorkspaceAppSqliteDatabasePath({ projectRoot: root, databasePath: 'apps/sales-ops/data.txt' })).toThrow('must end');

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-sqlite-'));
    try {
      fs.writeFileSync(path.join(outside, 'outside.sqlite'), '');
      fs.symlinkSync(path.join(outside, 'outside.sqlite'), path.join(root, 'apps', 'sales-ops', 'escape.sqlite'));
      expect(() => resolveWorkspaceAppSqliteDatabasePath({ projectRoot: root, databasePath: 'apps/sales-ops/escape.sqlite' })).toThrow('escapes');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
