import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';

const source = fs.readFileSync('scripts/nix-app/upgrade-production', 'utf8');
const planFunction = source.slice(source.indexOf('read_plan() {'), source.indexOf('\nprepare_local_release()'));
let root: string;
let baseline: string;
function git(...args: string[]) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim(); }
function commit() {
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  return git('rev-parse', 'HEAD');
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-plan-test-'));
  git('init', '-q');
  fs.mkdirSync(path.join(root, 'packages/backend/db/migrations'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/backend/db/migrations/001_base.sql'), 'SELECT 1;');
  baseline = commit();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function plan(failDiff = false) {
  const target = commit();
  git('update-ref', 'refs/remotes/origin/main', target);
  const status = path.join(root, 'status');
  fs.writeFileSync(status, `#!/bin/sh\nprintf '%s\\n' '{"authority":"nix","sourceRev":"${baseline}","storePath":"/nix/store/fixture","gcCurrent":"/nix/store/fixture","gcCurrentMatchesProduction":true}'\n`, { mode: 0o755 });
  const script = `set -Eeuo pipefail\nrepo_root="$1"; root_dir="$1"; state_file="$1/state.json"; restart_status_cmd="$1/status"\nassert_remote_target(){ :; }\nclassify_runtime_changes(){ echo '{"changedPaths":[],"runtimeChangedPaths":[],"runtimeChangeRequired":false}'; }\n${failDiff ? 'git(){ for arg in "$@"; do if [[ "$arg" = --no-renames ]]; then return 42; fi; done; command git "$@"; }' : ''}\n${planFunction}\nread_plan\n`;
  return spawnSync('bash', ['-c', script, 'fixture', root], { encoding: 'utf8' });
}
it('does not classify migration documentation or tests as executable SQL', () => {
  fs.writeFileSync(path.join(root, 'packages/backend/db/migrations/check.test.ts'), '// fixture');
  const result = plan();
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ dbMigrationRequired: false, dbMigrationChanges: [] });
});
it('retains modified SQL for explicit migration review', () => {
  fs.writeFileSync(path.join(root, 'packages/backend/db/migrations/001_base.sql'), 'SELECT 2;');
  const result = plan();
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ dbMigrationRequired: true, dbMigrationChanges: ['packages/backend/db/migrations/001_base.sql'] });
});
it('does not emit a ready plan when Git migration inspection fails', () => {
  fs.writeFileSync(path.join(root, 'change.txt'), 'fixture');
  const result = plan(true);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe('');
});
