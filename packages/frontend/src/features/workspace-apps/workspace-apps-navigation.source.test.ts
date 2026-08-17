import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync(path.resolve(import.meta.dirname, '../../App.tsx'), 'utf8');
const header = fs.readFileSync(path.resolve(import.meta.dirname, '../../components/layout/Header.tsx'), 'utf8');
const store = fs.readFileSync(path.resolve(import.meta.dirname, '../../stores/session-store.ts'), 'utf8');
const urlSync = fs.readFileSync(path.resolve(import.meta.dirname, '../../hooks/useUrlSync.ts'), 'utf8');
const koLayout = fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/ko/layout.json'), 'utf8');
const enLayout = fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/en/layout.json'), 'utf8');

const workspaceAppsHome = fs.readFileSync(path.resolve(import.meta.dirname, './WorkspaceAppsHome.tsx'), 'utf8');
const sampleDefinition = fs.readFileSync(path.resolve(import.meta.dirname, './sample-definition.ts'), 'utf8');

describe('Workspace Apps primary navigation skeleton', () => {
  it('adds Workspace Apps as a top-level workspace surface', () => {
    expect(store).toContain("'workspaceApps'");
    expect(header).toContain("const workspaceAppsEnabled = useSettingsStore((s) => s.serverConfig?.workspaceAppsEnabled === true)");
    expect(header).toContain("const workspaceAppsTab = workspaceAppsEnabled ? [{ key: 'workspaceApps', label: t('workspaceApps') }] : []");
    expect(header).toContain("case 'workspaceApps':");
    expect(header).toContain("if (!useSettingsStore.getState().serverConfig?.workspaceAppsEnabled) break;");
    expect(header).toContain("setActiveView('workspaceApps')");
    expect(header).toContain("activeView === 'workspaceApps' ? 'workspaceApps'");
  });

  it('renders the mock Workspace Apps home on desktop and mobile', () => {
    expect(app).toContain("import('./features/workspace-apps/WorkspaceAppsHome')");
    expect(app).toContain("const workspaceAppsEnabled = useSettingsStore((s) => s.serverConfig?.workspaceAppsEnabled === true)");
    expect(app).toContain("if (!workspaceAppsEnabled && activeView === 'workspaceApps')");
    expect(app.match(/activeView === 'workspaceApps' && workspaceAppsEnabled/g)?.length).toBe(2);
    expect(app.match(/<WorkspaceAppsHome \/>/g)?.length).toBe(2);
    expect(workspaceAppsHome).toContain('sampleWorkspaceAppDefinition');
    expect(workspaceAppsHome).toContain('<WorkspaceAppDashboard metrics={visibleDefinition.metrics} />');
    expect(workspaceAppsHome).toContain('<WorkspaceAppActionBar');
    expect(workspaceAppsHome).toContain('<WorkspaceAppRecordPanel');
    expect(workspaceAppsHome).toContain('selectedRowIndex={selectedRowIndex}');
    expect(sampleDefinition).toContain('업무 앱 · Local metadata renderer');
    expect(sampleDefinition).toContain('신규 등록');
  });

  it('keeps Workspace Apps URL-addressable and localized', () => {
    expect(urlSync).toContain("'workspaceApps'");
    expect(app).toContain("workspaceAppsEnabled && activeView === 'workspaceApps'");
    expect(koLayout).toContain('"workspaceApps": "업무"');
    expect(enLayout).toContain('"workspaceApps": "Apps"');
  });
});
