import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const manager = fs.readFileSync(new URL('./runtime-box-manager.ts', import.meta.url), 'utf8');
const projection = fs.readFileSync(new URL('./workbench-tool-projection.ts', import.meta.url), 'utf8');

// Structural contract fixture: Docker child mount ordering and fail-closed planner
// are security-sensitive and should remain visible in review even if helpers move.
describe('Workbench tool projection source contract', () => {
  it('overlays the active managed revision after the Project RW mount', () => {
    const projectMount = manager.indexOf("'-v',             `${box.project_root}:/workspace:rw`");
    const workbenchMount = manager.indexOf('...runtimeWorkbenchToolDockerMountArgs(workbenchPlan)');
    expect(projectMount).toBeGreaterThan(-1);
    expect(workbenchMount).toBeGreaterThan(projectMount);
    expect(projection).toContain('readonly,bind-propagation=rprivate');
  });

  it('uses DB current state and rejects incomplete/divergent managed metadata', () => {
    expect(projection).toContain('s.current_revision');
    expect(projection).toContain("row.storage_mode !== 'tower-managed-v1'");
    expect(projection).toContain('row.store_manifest_hash !== row.manifest_hash');
    expect(projection).toContain('readAndVerifyManagedWorkbenchToolRevision');
  });
});
