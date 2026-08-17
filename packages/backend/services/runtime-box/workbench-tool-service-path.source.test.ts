import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const manager = fs.readFileSync(path.join(import.meta.dirname, 'runtime-box-manager.ts'), 'utf8');
const services = fs.readFileSync(path.join(import.meta.dirname, 'service-registry.ts'), 'utf8');
const tools = fs.readFileSync(path.join(import.meta.dirname, 'workbench-tools.ts'), 'utf8');

describe('Managed Workbench PATH contract', () => {
  it('uses the same path composer for project_shell and service_start', () => {
    expect(manager).toContain('PATH=${withWorkbenchToolPath(requestedPath)}');
    expect(services).toContain('const workbenchPath = withWorkbenchToolPath(undefined)');
    expect(tools).toContain("`${activeBin}:/opt/tower-tools/bin:${basePath}`");
  });

  it('keeps already-running services unchanged and only applies PATH at start', () => {
    expect(services).toMatch(/startServiceProcess[\s\S]*'-e', `PATH=\$\{workbenchPath\}`/);
    expect(services).toContain('nohup setsid env PATH="$SERVICE_PATH" sh -c "$CMD"');
    expect(services).not.toContain('nohup setsid env PATH="$SERVICE_PATH" sh -lc "$CMD"');
    expect(services).toContain("'-e', `SERVICE_PATH=${workbenchPath}`");
    expect(services).not.toContain('UPDATE runtime_box_services SET environment_revision');
  });
});
