import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './pi-runtime-box-tools.ts'), 'utf8');

describe('Project bash UX contract', () => {
  it('presents one natural bash while the harness chooses the executor', () => {
    expect(source).toContain("name: 'bash'");
    expect(source).toContain("label: 'Bash'");
    expect(source).toContain('persistent working computer');
    expect(source).toContain('Commands start in /workspace');
    expect(source).toContain('Tower routes it to the execution authority already assigned to this Project');
    expect(source).toContain('Treat /workspace as the Project root');
    expect(source).toContain("name: 'project_process'");
    expect(source).toContain('started by bash');
  });

  it('does not expose Runtime Box as an ordinary AI-selectable shell', () => {
    expect(source).not.toContain("name: 'project_runtime_box_shell'");
    expect(source).toContain('Runtime Box is not an ordinary AI-selectable tool');
    expect(source).toContain('const compatibilityBashTool = {');
    expect(source).toContain("name: 'bash'");
    expect(source).toContain('parameters: WorkbenchExecuteParams');
    expect(source).toContain('cmd: params.command');
    expect(source).toMatch(/stableRuntimeTools = \[compatibilityBashTool, pdfRenderTool\][\s\S]*workbenchExecuteTool[\s\S]*projectProcessTool/);
  });

  it('records Worker foreground file effects under the bash surface', () => {
    expect(source).toContain("recordRuntimeBoxTouchedFiles(ctx.sessionId, 'bash', touchedFiles)");
  });
});
