import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Run the real plan entry point against an isolated Git repository and fake
// health/worker endpoints. Never contact Prod or run push/backup/cutover.
const source = fs.readFileSync('scripts/nix-app/orchestrate-operator-upgrade', 'utf8');
let root: string;
let live: string;
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
function put(name: string, body: string) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
function commit() {
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  return git('rev-parse', 'HEAD');
}
function plan() {
  return spawnSync('bash', [path.join(root, 'scripts/nix-app/orchestrate-operator-upgrade'), 'plan', '--source-rev', git('rev-parse', 'HEAD')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, TOWER_OPERATOR_UPGRADE_RUN_ROOT: `${root}/runs`, TOWER_OPERATOR_UPGRADE_HEALTH_URL: 'http://unused.invalid', TEST_LIVE_REV: live },
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-plan-test-'));
  git('init', '-q');
  put('scripts/nix-app/orchestrate-operator-upgrade', source);
  put('scripts/nix-app/worker-version-audit.py', 'print(\'{"status":"match","workers":[]}\')');
  put('bin/curl', '#!/bin/sh\nprintf \'{"status":"ok","sourceRev":"%s"}\\n\' "$TEST_LIVE_REV"\n');
  fs.chmodSync(path.join(root, 'bin/curl'), 0o755);
  put('packages/backend/db/migrations/001_base.sql', 'SELECT 1;\n');
  live = commit();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('Operator upgrade SQL-only plan behavior', () => {
  it('does not request DB approval for migration tests/docs', () => {
    put('packages/backend/db/migrations/check.test.ts', '// test');
    put('packages/backend/db/migrations/README.md', '# docs');
    commit();
    const result = plan();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ dbMigrationRequired: false });
  });
  it.each(['add', 'modify', 'delete', 'rename'] as const)('retains DB approval for SQL %s', (change) => {
    const base = 'packages/backend/db/migrations/001_base.sql';
    if (change === 'add') put('packages/backend/db/migrations/002_next.sql', 'SELECT 2;');
    if (change === 'modify') put(base, 'SELECT 3;');
    if (change === 'delete') fs.unlinkSync(path.join(root, base));
    if (change === 'rename') fs.renameSync(path.join(root, base), path.join(root, 'packages/backend/db/migrations/001_base.txt'));
    commit();
    const result = plan();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'approval-required-db-migrations', dbMigrationRequired: true });
    expect(result.stderr).toContain('.sql');
  });
  it('fails closed when migration diff fails instead of presenting an empty migration plan', () => {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    put('bin/git', `#!/bin/bash\nfor arg in "$@"; do if [[ "$arg" = --no-renames ]]; then exit 42; fi; done\nexec '${realGit}' "$@"\n`);
    fs.chmodSync(path.join(root, 'bin/git'), 0o755);
    const result = plan();
    expect(result.status).toBe(42);
    expect(result.stdout).not.toContain('"status":"ready');
  });
});
