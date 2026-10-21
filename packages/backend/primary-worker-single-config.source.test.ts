import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
describe('single primary Worker configuration', () => {
  it('uses the Backend primary for reconciliation and rejects conflicting legacy configuration', () => {
    const source = read('packages/backend/scripts/reconcile-primary-worker-assignment.ts');
    expect(source).toContain('process.env.TOWER_PRIMARY_WORKER_ID?.trim()');
    expect(source).toContain('TOWER_PRIMARY_WORKER_ID_REQUIRED');
    expect(source).toContain("legacyWorkerId !== workerId");
    expect(source).toContain('PRIMARY_WORKER_CONFIGURATION_MISMATCH');
    expect(source).not.toContain("|| 'tower-prod-local-01'");
  });
  it('does not pin an independent primary in the installed unit', () => {
    const source = read('scripts/nix-app/install-workbench-assignment-reconciler-unit');
    expect(source).toContain('worker_id="${TOWER_PRIMARY_WORKER_ID:-}"');
    expect(source).toContain('EnvironmentFile=$environment_file');
    expect(source).not.toContain('Environment=TOWER_ASSIGNMENT_PRIMARY_WORKER_ID=');
    expect(source).not.toContain('Environment=TOWER_PRIMARY_WORKER_ID=');
  });
  it('keeps worker-specific claims and existing-binding protection', () => {
    expect(read('packages/backend/services/runtime-box/workbench-project-worker-assignment.ts')).toContain("desired_worker_id=$2 AND status='pending'");
    expect(read('packages/backend/scripts/reconcile-primary-worker-assignment.ts')).toContain('ASSIGNMENT_EXISTING_BINDING_REQUIRES_EXPLICIT_CHANGE');
  });
  it('passes the canonical setting from both deployment installers', () => {
    for (const file of ['scripts/fleet/finalize-worker-after-cutover', 'scripts/fleet/fleet-shared-project-worker']) {
      expect(read(file)).toContain('TOWER_PRIMARY_WORKER_ID=');
      expect(read(file)).not.toContain('TOWER_ASSIGNMENT_PRIMARY_WORKER_ID=');
    }
  });
});
