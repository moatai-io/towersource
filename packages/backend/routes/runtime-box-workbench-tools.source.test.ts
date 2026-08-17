import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const api = fs.readFileSync(new URL('./runtime-box-api.ts', import.meta.url), 'utf8');

describe('Workbench tool Runtime Box API contract', () => {
  it('keeps read endpoints while closing HTTP preview and apply for the PoC', () => {
    expect(api).toContain("router.get('/projects/:projectId/workbench-tools'");
    expect(api).toContain("router.get('/projects/:projectId/workbench-tools/revisions'");
    expect(api).toContain('Workbench tool preview is closed on HTTP during the internal experimental PoC');
    expect(api).toContain('Workbench tool apply is closed on HTTP during the internal experimental PoC');
    expect(api).not.toContain('previewWorkbenchToolChange');
    expect(api).not.toContain('applyWorkbenchToolChange');
  });

  it('has no direct install or rollback route', () => {
    expect(api).not.toContain("workbench-tools/install'");
    expect(api).not.toContain("workbench-tools/rollback'");
  });
});
