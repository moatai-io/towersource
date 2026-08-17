import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const manager = fs.readFileSync(path.resolve(import.meta.dirname, 'runtime-box-manager.ts'), 'utf8');
const helper = fs.readFileSync(path.resolve(import.meta.dirname, 'runtime-box-container-observation.ts'), 'utf8');
const reconcile = manager.slice(manager.indexOf('export async function reconcileRuntimeBoxes'), manager.indexOf('// ── 유틸'));

describe('L3b Runtime observation scope contract', () => {
  it('keeps the observation helper mutation-free', () => {
    expect(helper).not.toContain('execute(');
    expect(helper).not.toContain('queryOne(');
    expect(helper).not.toContain('stopDockerContainer');
    expect(helper).not.toContain('docker rm');
  });

  it('skips unknown and identity mismatch before every reconcile mutation', () => {
    const guard = "if (observation.kind === 'inspection_unknown' || observation.kind === 'identity_mismatch')";
    expect(reconcile).toContain(guard);
    expect(reconcile.indexOf(guard)).toBeLessThan(reconcile.indexOf('await stopDockerContainer'));
    expect(reconcile.indexOf(guard)).toBeLessThan(reconcile.indexOf('await execute('));
  });

  it('allows existing mutation branches only for confirmed observations', () => {
    expect(reconcile).toContain("observation.kind === 'not_found' || observation.kind === 'not_running'");
    expect(reconcile).toContain("observation.kind === 'running' || observation.kind === 'not_running'");
    expect(reconcile).not.toContain('inspection_unknown ?');
    expect(reconcile).not.toContain("status = 'error'");
    expect(reconcile).not.toContain('recovery_required');
  });
});
