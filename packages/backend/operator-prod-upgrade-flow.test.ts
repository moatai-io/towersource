import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Execute the real detached CLI + real environment-keyed attestation verifier.
// All endpoints, push, build, and validation work are isolated fixture commands.
const runner = fs.readFileSync('scripts/nix-app/orchestrate-operator-upgrade', 'utf8');
const verifier = fs.readFileSync('scripts/git/pre-push-verified-state', 'utf8');
let root: string;
let live: string;
let target: string;
let env: NodeJS.ProcessEnv;
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
function put(name: string, body: string, executable = false) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: executable ? 0o755 : 0o644 });
}
function commit() {
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  return git('rev-parse', 'HEAD');
}
function cli(action: string, approval?: string) {
  return spawnSync('bash', [`${root}/scripts/nix-app/orchestrate-operator-upgrade`, action, '--source-rev', target, ...(approval ? ['--approve-db-migrations', approval] : [])], { encoding: 'utf8', env, timeout: 10_000 });
}
function state() { return JSON.parse(fs.readFileSync(`${root}/runs/${target}/state.json`, 'utf8')); }
function calls() { return fs.existsSync(`${root}/calls`) ? fs.readFileSync(`${root}/calls`, 'utf8').trim().split('\n') : []; }
async function settled() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const terminal = ['prepared', 'awaiting-approval', 'done', 'done-push-only', 'failed'];
    if (terminal.includes(state().phase)) {
      // A terminal write precedes child exit; do not race a relaunch with the lock.
      if (spawnSync('flock', ['-n', `${root}/runs/${target}/runner.lock`, 'true']).status === 0) return state();
    }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`runner did not settle: ${JSON.stringify(state())}\n${fs.readFileSync(`${root}/runs/${target}/run.log`, 'utf8')}`);
}
function change(sql = true) {
  put(sql ? 'packages/backend/db/migrations/002_next.sql' : 'docs/new.md', sql ? 'SELECT 2;' : '# Next');
  target = commit();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-upgrade-flow-'));
  git('init', '-q');
  put('scripts/nix-app/orchestrate-operator-upgrade', runner, true);
  put('scripts/git/pre-push-verified-state', verifier, true);
  put('scripts/git/materialize-committed-source', '#!/bin/bash\nset -eu\nmkdir -p "$3"\ngit -C "$1" archive "$2" | tar -x -C "$3"\n', true);
  put('scripts/git/push-main-safe', `#!/bin/bash
set -eu
echo "push-$1" >> "$TEST_ROOT/calls"
case "$1" in
  plan)
    [[ ! -f "$TEST_ROOT/remote-unavailable" ]] || exit 22
    if [[ -f "$TEST_ROOT/pushed" ]]; then
      printf '{"status":"up-to-date","sourceRev":"%s","remoteSha":"%s","localOnly":0,"remoteOnly":0}\\n' "$3" "$3"
    else
      printf '{"status":"ready-to-push","sourceRev":"%s","remoteSha":"%s","localOnly":1,"remoteOnly":0}\\n' "$3" "$TEST_LIVE_REV"
    fi;;
  prepare) [[ "\${TEST_SKIP_PUSH_PREPARE:-0}" = 1 ]] || "$TOWER_PUSH_MAIN_ROOT/scripts/git/pre-push-verified-state" "$3";;
  apply)
    if [[ -f "$TEST_ROOT/pushed" ]]; then echo up-to-date >> "$TEST_ROOT/calls"; exit 0; fi
    echo hook >> "$TEST_ROOT/calls"
    "$TOWER_PUSH_MAIN_ROOT/scripts/git/pre-push-verified-state" "$3"
    [[ ! -f "$TEST_ROOT/push-fail" ]]
    echo pushed >> "$TEST_ROOT/calls"
    touch "$TEST_ROOT/pushed"
    [[ ! -f "$TEST_ROOT/post-push-fail" ]];;
esac
`, true);
  put('scripts/nix-app/upgrade-production', '#!/bin/bash\necho "upgrade-$1" >> "$TEST_ROOT/calls"\nexit 43\n', true);
  put('scripts/nix-app/prewarm-production', '#!/bin/bash\necho unexpected-prewarm >> "$TEST_ROOT/calls"\nexit 44\n', true);
  put('scripts/nix-app/restart-pinned-production', '#!/bin/bash\necho authority >> "$TEST_ROOT/calls"\nprintf \'{"authority":"nix","sourceRev":"%s","gcCurrentMatchesProduction":true}\' "$TEST_LIVE_REV"\n', true);
  put('scripts/nix-app/worker-version-audit.py', 'print(\'{"status":"match","workers":[]}\')');
  put('bin/curl', '#!/bin/bash\nprintf \'{"status":"ok","sourceRev":"%s"}\\n\' "${TEST_LIVE_REV}"\n', true);
  put('packages/backend/db/migrations/001_base.sql', 'SELECT 1;');
  live = commit();
  target = live;
  env = {
    ...process.env,
    PATH: `${root}/bin:${process.env.PATH}`,
    TEST_ROOT: root,
    TEST_LIVE_REV: live,
    TOWER_OPERATOR_UPGRADE_RUN_ROOT: `${root}/runs`,
    TOWER_OPERATOR_UPGRADE_HEALTH_URL: 'http://unused.invalid',
    TOWER_OPERATOR_UPGRADE_PUSH_CMD: `${root}/scripts/git/push-main-safe`,
    TOWER_OPERATOR_UPGRADE_PREWARM_CMD: `${root}/scripts/nix-app/prewarm-production`,
    TOWER_OPERATOR_UPGRADE_AUTHORITY_CMD: `${root}/scripts/nix-app/restart-pinned-production`,
    TOWER_PREPUSH_CACHE_DIR: `${root}/cache`,
    TOWER_PREPUSH_SNAPSHOT_ROOT: `${root}/snapshots`,
    TOWER_PREPUSH_MATERIALIZER: `${root}/scripts/git/materialize-committed-source`,
    TOWER_PREPUSH_NODE_BIN: '/bin/true',
    TOWER_PREPUSH_NPM_BIN: '/bin/true',
    TOWER_PREPUSH_FORCE_FULL: '0',
    TOWER_PREPUSH_COMMAND: 'echo validation >> "$TEST_ROOT/calls"; test ! -f "$TEST_ROOT/preflight-fail" # npm ci',
    TOWER_PUSH_MAIN_ROOT: '/wrong/inherited/root',
    TOWER_PREPUSH_ROOT: '/wrong/inherited/root',
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('Operator upgrade preparation and approval execution', () => {
  it('[deploy-smoke] keeps plan read-only and does not run validation', () => {
    change();
    expect(cli('plan').status).toBe(0);
    expect(calls()).toEqual([]);
    expect(fs.existsSync(`${root}/runs`)).toBe(false);
  });

  it('[deploy-smoke] validates first, then waits without push/build/DB/cutover, including premature approval', async () => {
    change();
    expect(cli('run', target).status).toBe(0);
    const result = await settled();
    expect(result).toMatchObject({ phase: 'awaiting-approval', mutationStarted: false, dbMigrationApprovedRev: null, validationEvidence: { status: 'passed', sha: target, liveRev: live } });
    expect(result.validationEvidence.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.result).toMatchObject({ migrationPaths: ['packages/backend/db/migrations/002_next.sql'], pushPerformed: false, cutoverPerformed: false });
    expect(calls()).toEqual(['push-prepare', 'validation']);
    expect(cli('status').status).toBe(0);
    expect(calls()).toEqual(['push-prepare', 'validation']);
  }, 30_000);

  it('does not overlap an older mkdir-lock runner', () => {
    change();
    fs.mkdirSync(`${root}/runs/${target}/running`, { recursive: true });
    expect(cli('run').status).toBe(25);
    expect(calls()).toEqual([]);
  });

  it('[deploy-smoke] rejects mismatched approval before launching work', () => {
    change();
    expect(cli('run', live).status).toBe(30);
    expect(calls()).toEqual([]);
  });

  it('reuses exact evidence but still executes the hook; failed mutable work is not repeated', async () => {
    change();
    cli('run');
    await settled();
    expect(cli('run', target).status).toBe(0);
    expect(await settled()).toMatchObject({ phase: 'failed', mutationStarted: true, dbMigrationApprovedRev: target });
    expect(calls()).toEqual(['push-prepare', 'validation', 'push-prepare', 'push-apply', 'hook', 'pushed', 'upgrade-prepare']);
    const before = calls();
    expect(cli('run', target).status).toBe(31);
    expect(cli('status').status).toBe(0);
    expect(calls()).toEqual(before);
  }, 30_000);

  it('[deploy-smoke] does not treat an up-to-date remote as validation evidence', async () => {
    change();
    env.TEST_SKIP_PUSH_PREPARE = '1';
    cli('prepare');
    expect(await settled()).toMatchObject({ phase: 'awaiting-approval', validationEvidence: { sha: target, status: 'passed' } });
    expect(calls()).toEqual(['push-prepare', 'validation']);
  }, 30_000);

  it('invalidates approval readiness when the validation environment changes', async () => {
    change();
    cli('prepare');
    const first = await settled();
    env.TOWER_PREPUSH_COMMAND += '\n# different validation contract';
    cli('run', target);
    const next = await settled();
    expect(next.phase).toBe('awaiting-approval');
    expect(next.validationEvidence.fingerprint).not.toBe(first.validationEvidence.fingerprint);
    expect(calls().filter(c => c === 'validation')).toHaveLength(2);
    expect(calls()).not.toContain('push-apply');
  }, 30_000);

  it('invalidates approval readiness when the live baseline changes', async () => {
    put('docs/intermediate.md', '# Baseline');
    const intermediate = commit();
    change();
    cli('prepare');
    await settled();
    env.TEST_LIVE_REV = intermediate;
    cli('run', target);
    expect(await settled()).toMatchObject({ phase: 'awaiting-approval', validationEvidence: { liveRev: intermediate } });
    expect(calls()).not.toContain('push-apply');
  }, 30_000);

  it('reconciles a failed push and retries with hooks and current attestation', async () => {
    change(false);
    put('push-fail', '');
    cli('run');
    expect(await settled()).toMatchObject({ phase: 'failed', mutationStarted: true, lastMutationPhase: 'pushing' });
    fs.unlinkSync(`${root}/push-fail`);
    env.TOWER_PREPUSH_COMMAND += '\n# changed before retry';
    expect(cli('run').status).toBe(0);
    expect(await settled()).toMatchObject({ phase: 'done-push-only' });
    expect(calls().filter(c => c === 'push-plan')).toHaveLength(1);
    expect(calls().filter(c => c === 'hook')).toHaveLength(2);
    expect(calls().filter(c => c === 'validation')).toHaveLength(2);
    expect(calls().filter(c => c === 'pushed')).toHaveLength(1);
  }, 30_000);

  it('resumes a push-only interruption with the same exact DB approval evidence', async () => {
    change();
    cli('prepare');
    await settled();
    put('push-fail', '');
    cli('run', target);
    expect(await settled()).toMatchObject({ phase: 'failed', lastMutationPhase: 'pushing', dbMigrationApprovedRev: target });
    const interrupted = state();
    interrupted.phase = 'interrupted-needs-review';
    put(`runs/${target}/state.json`, JSON.stringify(interrupted));
    fs.unlinkSync(`${root}/push-fail`);
    cli('run', target);
    expect(await settled()).toMatchObject({ phase: 'failed', lastMutationPhase: 'preparing', dbMigrationApprovedRev: target });
    expect(calls().filter(c => c === 'validation')).toHaveLength(1);
    expect(calls().filter(c => c === 'upgrade-prepare')).toHaveLength(1);
    const before = calls();
    expect(cli('run', target).status).toBe(31);
    expect(calls()).toEqual(before);
  }, 30_000);

  it('does not duplicate an already completed remote push after a lost response', async () => {
    change(false);
    put('post-push-fail', '');
    cli('run');
    expect(await settled()).toMatchObject({ phase: 'failed', lastMutationPhase: 'pushing' });
    cli('run');
    expect(await settled()).toMatchObject({ phase: 'done-push-only' });
    expect(calls()).toContain('up-to-date');
    expect(calls().filter(c => c === 'pushed')).toHaveLength(1);
    expect(calls().filter(c => c === 'hook')).toHaveLength(1);
  }, 30_000);

  it('preserves failed state when remote reconciliation fails and blocks unknown legacy mutations', async () => {
    change(false);
    put('push-fail', '');
    cli('run');
    await settled();
    const failed = state();
    put('remote-unavailable', '');
    expect(cli('run').status).toBe(22);
    expect(state()).toEqual(failed);
    const before = calls();
    delete failed.mutationStarted;
    delete failed.lastMutationPhase;
    put(`runs/${target}/state.json`, JSON.stringify(failed));
    expect(cli('run').status).toBe(31);
    expect(calls()).toEqual(before);
  }, 30_000);

  it('rejects retrying a failed committed snapshot after the working tree changed', async () => {
    change();
    put('preflight-fail', '');
    cli('run');
    expect(await settled()).toMatchObject({ phase: 'failed', mutationStarted: false });
    fs.unlinkSync(`${root}/preflight-fail`);
    cli('run', target);
    expect(await settled()).toMatchObject({ phase: 'failed', mutationStarted: false });
    expect(calls().filter(c => c === 'validation')).toHaveLength(1);
    expect(calls()).not.toContain('push-apply');
  }, 30_000);

  it('[deploy-smoke] prepares host-only changes without pushing, then completes only once', async () => {
    change(false);
    cli('prepare');
    expect(await settled()).toMatchObject({ phase: 'prepared', mutationStarted: false });
    expect(calls()).not.toContain('push-apply');
    cli('run');
    expect(await settled()).toMatchObject({ phase: 'done-push-only', result: { cutoverPerformed: false } });
    const before = calls();
    expect(cli('run').status).toBe(0);
    expect(calls()).toEqual(before);
    expect(calls().filter(c => c === 'validation')).toHaveLength(1);
    expect(calls()).toContain('hook');
  }, 30_000);

  it('serializes launch and status while the detached runner owns the lock', async () => {
    change();
    env.TOWER_PREPUSH_COMMAND = 'echo validation >> "$TEST_ROOT/calls"; sleep 1 # npm ci';
    cli('run');
    expect(cli('run').status).toBe(25);
    const snapshot = cli('status');
    expect(snapshot.status).toBe(0);
    expect(JSON.parse(snapshot.stdout).phase).not.toBe('interrupted-needs-review');
    expect(await settled()).toMatchObject({ phase: 'awaiting-approval' });
    expect(calls().filter(c => c === 'validation')).toHaveLength(1);
  }, 30_000);
});
