import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const orchestrator = fs.readFileSync(path.join(root, 'scripts/nix-app/orchestrate-operator-upgrade'), 'utf8');
const start = fs.readFileSync(path.join(root, 'start.sh'), 'utf8');

describe('Operator Prod upgrade orchestration source contract', () => {
  it('pins one exact revision and delegates the whole mutable run to a detached owner', () => {
    expect(orchestrator).toContain('source_rev="$(git -C "$repo_root" rev-parse HEAD)"');
    expect(orchestrator).toContain('setsid nohup "$0" "${args[@]}"');
    expect(orchestrator).toContain('args=(__runner --source-rev "$source_rev" --timeout "$timeout")');
    expect(orchestrator).toContain('detached runner owns exact push and any required Prod transition');
    expect(orchestrator).toContain('"$$" <<\'PY\'');
    expect(orchestrator).toContain("'runnerPid':int(runner)");
    expect(orchestrator.indexOf('setsid nohup "$0"')).toBeLessThan(orchestrator.indexOf('write_state preflight'));
  });

  it('uses full preflight and exact non-force push before prepare or activation', () => {
    expect(orchestrator).toContain('"$push_cmd" prepare --source-rev "$source_rev"');
    expect(orchestrator).toContain('"$push_cmd" apply --approve-rev "$source_rev"');
    expect(orchestrator).toContain('TOWER_PUSH_AUTO_PREWARM=0');
    expect(orchestrator.indexOf('"$push_cmd" prepare')).toBeLessThan(orchestrator.indexOf('"$push_cmd" apply'));
    expect(orchestrator.indexOf('"$push_cmd" apply')).toBeLessThan(orchestrator.indexOf('"$prewarm_cmd" start'));
  });

  it('classifies explicit host-only paths and ends them without Nix prepare or cutover', () => {
    expect(orchestrator).toContain('classify_runtime_changes()');
    expect(orchestrator).toContain('"skills/"');
    expect(orchestrator).toContain('"scripts/nix-app/orchestrate-operator-upgrade"');
    expect(orchestrator).toContain('"scripts/nix-app/upgrade-production"');
    expect(orchestrator).toContain('is_test(p)');
    expect(orchestrator).toContain("status='approval-required-db-migrations' if int(count) else ('up-to-date' if source==live else ('ready' if r['runtimeChangeRequired'] else 'ready-push-only'))");
    const pushOnly = orchestrator.slice(orchestrator.indexOf('if [[ "$runtime_required" = false'), orchestrator.indexOf('terminal_state='));
    expect(pushOnly).toContain('done-push-only');
    expect(pushOnly).toContain("'cutoverPerformed':False");
    expect(pushOnly).not.toContain('prewarm_cmd');
    expect(pushOnly).not.toContain('upgrade-production');
  });

  it('requires exact migration approval and backs up before applying or cutting over', () => {
    expect(orchestrator).toContain('"$approved_migration_rev" != "$source_rev"');
    expect(orchestrator).toContain('migration approval does not equal source revision');
    expect(orchestrator).toContain('pg_dump -Fc --file "$backup" "$DATABASE_URL"');
    expect(orchestrator).toContain('sha256sum "$backup" >"$backup.sha256"');
    const prepare = orchestrator.indexOf('prepare --source-rev "$source_rev" --ack-db-migrations-separate');
    const backup = orchestrator.indexOf('pg_dump -Fc');
    const migration = orchestrator.indexOf('apply-db-migrations.js" apply');
    const activation = orchestrator.indexOf('activate --approve-rev "$source_rev"');
    expect(prepare).toBeLessThan(backup);
    expect(backup).toBeLessThan(migration);
    expect(migration).toBeLessThan(activation);
  });

  it('reconciles a dead runner from exact health and Nix authority without retrying mutation', () => {
    const reconcile = orchestrator.slice(orchestrator.indexOf('reconcile_state(){'), orchestrator.indexOf('if [[ "$action" = status'));
    expect(reconcile).toContain('kill -0 "$runner_pid"');
    expect(reconcile).toContain("h.get('sourceRev')==e");
    expect(reconcile).toContain("a.get('gcCurrentMatchesProduction') is True");
    expect(reconcile).toContain("'phase':'done'");
    expect(reconcile).toContain("'phase':'interrupted-needs-review'");
    expect(reconcile).not.toContain('push_cmd');
    expect(reconcile).not.toContain('prewarm_cmd');
    expect(reconcile).not.toContain('upgrade-production');
  });

  it('keeps Workers outside the mutation path and exposes durable start/status entry points', () => {
    expect(orchestrator).toContain("'workerRestartIncluded':False");
    expect(orchestrator).toContain('Workers remain untouched');
    expect(orchestrator).not.toContain('systemctl');
    expect(orchestrator).not.toContain('tower-workbench-worker.service');
    expect(orchestrator).toContain('run_dir="$run_root/$source_rev"');
    expect(start).toContain('prod-upgrade-latest)');
    expect(start).toContain('orchestrate-operator-upgrade run "$@"');
    expect(start).toContain('prod-upgrade-latest-status)');
  });
});
