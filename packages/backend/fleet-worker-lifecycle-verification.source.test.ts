import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const remote = readFileSync(new URL('../../scripts/fleet/fleet-nix-remote', import.meta.url), 'utf8');
const rollout = readFileSync(new URL('../../scripts/fleet/upgrade-fleet-production', import.meta.url), 'utf8');
const cutover = readFileSync(new URL('../../scripts/nix-app/cutover-production', import.meta.url), 'utf8');
const finalizerPath = new URL('../../scripts/fleet/finalize-worker-after-cutover', import.meta.url);
const finalizer = readFileSync(finalizerPath, 'utf8');

describe('Fleet signed-grant Worker lifecycle verification', () => {
  it('moves Worker finalization inside the rollback-owned cutover runner', () => {
    expect(remote).toContain('finalize-worker-after-cutover');
    expect(remote).toContain('TOWER_NIX_POST_CUTOVER_HOOK');
    const cutoverBlock = remote.slice(remote.indexOf('  cutover)'), remote.indexOf('  cutover-status)'));
    expect(cutoverBlock).not.toContain('if grep -q \'^TOWER_WORKER_SIGNED_EXECUTION_GRANTS=true$\'');
    expect(cutover).toContain('"$post_hook" preflight');
    expect(cutover).toContain('"$post_hook" apply');
    expect(cutover).toContain('"$post_hook" rollback');
    expect(cutover).toContain('write_state finalizing');
  });

  it('preflights every privileged dependency before service mutation', () => {
    expect(finalizer).toContain('sudo -n true');
    expect(finalizer).toContain('sudo -n test -r "$config"');
    expect(finalizer).toContain('sudo -n test -r "$identity"');
    expect(finalizer).toContain('systemctl is-active --quiet "$worker_unit"');
    expect(finalizer).toContain('worker-finalize: active admin actor missing');
    expect(finalizer).toContain('worker-finalize: Worker max-runs missing');
  });

  it('restores the prior reconciler store when the app cutover rolls back', () => {
    expect(finalizer).toContain("priorStore");
    expect(finalizer).toContain('install_for_store "$prior_store"');
    expect(finalizer).toContain('sudo -n systemctl enable --now "$timer"');
  });

  it('converges the Worker before cutover and does not repeat maintenance afterward', () => {
    const cutoverFn = rollout.slice(rollout.indexOf('  cutover_verify_customer()'), rollout.indexOf('\n  mapfile -t targets'));
    expect(cutoverFn.indexOf('deploy-worker')).toBeLessThan(cutoverFn.indexOf('cutover "$customer"'));
    expect(cutoverFn.match(/deploy-worker/g)).toHaveLength(1);
    expect(remote).toContain('"result":"already-aligned"');
    expect(remote).toContain('path=$store/bin/tower-workbench-worker ');
  });

  it('enrolls legacy Fleet Workers from a root-only database projection before convergence', () => {
    const deployBlock = remote.slice(remote.indexOf('  deploy-worker)'), remote.indexOf('  promote-verify)'));
    expect(deployBlock).toContain('maintenance-db.env');
    expect(deployBlock).toContain('sudo -n test -r "$config"');
    expect(deployBlock).toContain('sudo -n test -r "$transport"');
    expect(deployBlock).not.toContain('[[ -r "$config"');
    expect(deployBlock).toContain("raw.startswith('DATABASE_URL=')");
    expect(deployBlock).toContain('os.fchmod(f.fileno(),0o600)');
    expect(deployBlock).toContain('os.replace(tmp,target)');
    expect(deployBlock).toContain('TOWER_WORKER_MAINTENANCE_DATABASE_ENV_FILE="$db_env"');
    expect(deployBlock).toContain('"$store/bin/install-worker-maintenance"');
    expect(deployBlock.indexOf('install-worker-maintenance')).toBeLessThan(deployBlock.indexOf('tower-worker-maintenance" deploy-installed'));
    expect(deployBlock).not.toContain('cat "$PWD/.env"');
    expect(deployBlock).not.toContain('source "$PWD/.env"');
  });

  it('keeps terminal verification strict for heartbeat and exact reconciler closure', () => {
    expect(remote).toContain("heartbeatAgeSec',999999)<15");
    expect(remote).toContain("reconcilerExec','').startswith('{ path='+store+'/bin/tower-workbench-assignment-reconciler '");
    expect(remote).toContain("worker_lifecycle.get('timer')=='active'");
  });
});

describe('Worker finalizer executable contract', () => {
  it('skips cleanly when signed Worker grants are disabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-finalize-off-'));
    const prod = join(root, 'prod');
    mkdirSync(prod);
    writeFileSync(join(prod, '.env'), 'TOWER_WORKER_SIGNED_EXECUTION_GRANTS=false\n');
    const result = spawnSync(finalizerPath.pathname, ['preflight', '/nix/store/not-used-for-disabled-worker', prod, join(root, 'receipt.json')], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('not-required');
  });
});
