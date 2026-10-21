import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './project-manager.ts'), 'utf8');

describe('new Project Worker-lite provisioning contract', () => {
  it('provisions canonical storage as a required creation step', () => {
    expect(source).toContain('await provisionCanonicalProjectWorkspace({ projectId: id, deploymentId: resolveProjectEnvironmentDeploymentId() })');
    expect(source).toContain('canonical storage provisioning failed');
    expect(source).toContain("await execute('DELETE FROM projects WHERE id = $1', [id])");
  });

  it('does not queue automatic Worker assignment from ordinary Project creation', () => {
    expect(source).not.toContain("import('../runtime-box/workbench-project-worker-auto-request.js')");
    expect(source).not.toContain('requestAutomaticProjectWorkerAssignment({ projectId: id');
    expect(source).toContain('New Projects are not assigned a Worker or static Worker Project scope');
  });
});
