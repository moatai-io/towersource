import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const frontendSrc = path.resolve(import.meta.dirname, '../..');
const backendRoot = path.resolve(import.meta.dirname, '../../../../backend');
const backendConfig = fs.readFileSync(path.join(backendRoot, 'config.ts'), 'utf8');
const backendApi = fs.readFileSync(path.join(backendRoot, 'routes/api.ts'), 'utf8');
const settingsStore = fs.readFileSync(path.join(frontendSrc, 'stores/settings-store.ts'), 'utf8');
const header = fs.readFileSync(path.join(frontendSrc, 'components/layout/Header.tsx'), 'utf8');
const app = fs.readFileSync(path.join(frontendSrc, 'App.tsx'), 'utf8');

describe('Workspace Apps private beta gate', () => {
  it('keeps the DIY ERP Connector beta full-operator-only by default with an env rollback', () => {
    expect(backendConfig).toContain('export function isWorkspaceAppsEnabledForVm');
    expect(backendConfig).toContain("if (role === 'full') return flag !== 'false';");
    expect(backendConfig).toContain("return flag === 'true';");
    expect(backendConfig).toContain('get workspaceAppsEnabled(): boolean');
    expect(backendConfig).toContain('get workspaceAppsMode(): WorkspaceAppsMode');
    expect(backendApi).toContain('workspaceAppsEnabled: config.workspaceAppsEnabled');
    expect(backendApi).toContain('workspaceAppsMode: config.workspaceAppsMode');
  });

  it('does not show or mount Workspace Apps even if serverConfig still exposes the private beta flags', () => {
    expect(settingsStore).toContain('workspaceAppsEnabled?: boolean');
    expect(settingsStore).toContain("workspaceAppsMode?: 'local-metadata' | 'frappe-connector-pilot'");
    expect(header).not.toContain('workspaceAppsEnabled');
    expect(header).not.toContain("key: 'workspaceApps'");
    expect(app).not.toContain('workspaceAppsEnabled');
    expect(app).not.toContain("activeView === 'workspaceApps'");
    expect(app).not.toContain('<WorkspaceAppsHome />');
  });
});
