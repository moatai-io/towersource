import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('dormant product surface retirement', () => {
  it('removes Workspace Apps configuration and locale payloads with the deleted runtime', () => {
    const config = read('packages/backend/config.ts');
    const en = read('packages/frontend/src/locales/en/common.json');
    const ko = read('packages/frontend/src/locales/ko/common.json');

    for (const retired of [
      'WorkspaceAppsMode',
      'isWorkspaceAppsEnabledForVm',
      'resolveWorkspaceAppsMode',
      'workspaceAppsEnabled',
      'workspaceAppsMode',
      'TOWER_WORKSPACE_APPS_ENABLED',
      'TOWER_WORKSPACE_APPS_MODE',
    ]) {
      expect(config).not.toContain(retired);
    }
    expect(en).not.toContain('"workspaceApps"');
    expect(ko).not.toContain('"workspaceApps"');
  });

  it('keeps deleted UI and backend surfaces absent from active source contracts', () => {
    const api = read('packages/backend/routes/api.ts');
    const app = read('packages/frontend/src/App.tsx');
    const i18n = read('packages/frontend/src/i18n.ts');

    expect(api).not.toContain("./workspace-apps-api.js");
    expect(api).not.toContain("router.post('/files/cad-qa'");
    expect(app).not.toContain('KanbanBoard');
    expect(app).not.toContain('AutomationPanel');
    expect(i18n).not.toContain("./locales/en/kanban.json");
    expect(i18n).not.toContain("./locales/ko/kanban.json");
  });
});
