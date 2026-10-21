import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

const operationalSources = [
  'scripts/nix-app/install-local-workbench-worker-units',
  'scripts/nix-app/install-system-workbench-worker-units',
  'scripts/nix-app/install-workbench-assignment-reconciler-unit',
  'packages/backend/scripts/bootstrap-system-workbench-worker-credentials.ts',
  'packages/backend/scripts/local-workbench-worker-heartbeat.ts',
  'packages/backend/scripts/reconcile-primary-worker-assignment.ts',
  'scripts/oss/bootstrap-local-worker.sh',
  'scripts/fleet/fleet-project-worker-bootstrap',
  'scripts/fleet/fleet-project-worker-apply',
  'scripts/fleet/fleet-shared-project-worker',
] as const;

describe('Worker capacity default contract', () => {
  it('keeps every operational bootstrap, installer, heartbeat, and reconciler default at twenty', () => {
    const source = operationalSources.map(read).join('\n');
    expect(source).toContain('TOWER_LOCAL_WORKER_MAX_RUNS:-20');
    expect(source).toContain("TOWER_BOOTSTRAP_MAX_RUNS?.trim() || '20'");
    expect(source).toContain('TOWER_LOCAL_WORKER_MAX_RUNS ?? 20');
    expect(source).toContain("TOWER_ASSIGNMENT_PRIMARY_MAX_RUNS?.trim() || '20'");
    expect(source).toContain('TOWER_ASSIGNMENT_PRIMARY_MAX_RUNS:-20');
    expect(source).toContain('TOWER_SHARED_WORKER_MAX_RUNS:-20');
    expect(source).not.toMatch(/TOWER_(?:LOCAL_WORKER|BOOTSTRAP|ASSIGNMENT_PRIMARY|SHARED_WORKER)_MAX_RUNS(?:=|:-|\?\.trim\(\) \|\|| \?\?)['\"]?[145]['\"]?/);
    expect(source).not.toContain('maxRuns: 4');
  });

  it('retains environment overrides instead of hard-coding twenty into generated units', () => {
    expect(read('scripts/nix-app/install-local-workbench-worker-units')).toContain('${TOWER_LOCAL_WORKER_MAX_RUNS:-20}');
    expect(read('scripts/nix-app/install-system-workbench-worker-units')).toContain('${TOWER_LOCAL_WORKER_MAX_RUNS:-20}');
    expect(read('scripts/nix-app/install-workbench-assignment-reconciler-unit')).toContain('${TOWER_ASSIGNMENT_PRIMARY_MAX_RUNS:-20}');
  });
});
