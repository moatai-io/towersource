import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './pi-runtime-box-tools.ts'), 'utf8');

describe('Project bash UX contract', () => {
  it('presents one natural bash while the harness chooses the executor', () => {
    expect(source).toContain("name: 'bash'");
    expect(source).toContain("label: 'Bash'");
    expect(source).toContain('Project execution environment');
    expect(source).toContain('Commands start in /workspace');
    expect(source).toContain('Operator access is a separate native host permission');
    expect(source).toContain('Treat /workspace as the Project root');
    expect(source).not.toContain("authorityMode: operatorResolution.operatorPlane ? 'operator-plane'");
    expect(source).not.toContain("operatorResolution.credentialMode !== 'none'");
    expect(source).toContain("name: 'project_process'");
    expect(source).toContain('started by bash');
  });

  it('does not expose Runtime Box or a rollout-gated error shell as an ordinary Project shell', () => {
    expect(source).not.toContain("name: 'project_runtime_box_shell'");
    expect(source).toContain("name: 'project_shell_legacy'");
    expect(source).toContain("name: 'bash'");
    expect(source).toContain('parameters: WorkbenchExecuteParams');
    expect(source).toMatch(/workbenchExecuteTool[\s\S]*projectProcessTool/);
    expect(source).toContain('Ordinary Project shell access is no longer a Workbench beta rollout decision');
    expect(source).not.toContain('const unavailableBashTool = {');
    expect(source).not.toContain('const stableRuntimeTools = compatibilityEnabled');
    expect(source).not.toContain('this Project has no active Worker binding and Runtime Box compatibility is disabled');
  });

  it('records Worker foreground file effects under the bash surface', () => {
    expect(source).toContain("recordRuntimeBoxTouchedFiles(ctx.sessionId, 'bash', touchedFiles)");
  });
});
