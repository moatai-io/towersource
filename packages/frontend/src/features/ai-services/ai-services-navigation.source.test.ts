import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const header = fs.readFileSync(path.join(root, 'components/layout/Header.tsx'), 'utf8');
const agentFirstNav = header.match(/if \(agentFirstEnabled\) \{([\s\S]*?)\n    \}\n    const list/)?.[1] || '';
const legacyNav = header.split("const list: { key: string; label: string; badge?: number }[] = [{ key: 'ai', label: t('ai') }]")[1]?.split('const activeKey')[0] || '';
const settingsManagement = header.split('/* ── Settings and management ── */')[1]?.split('/* ── Help ── */')[0] || '';
const operations = header.split('/* ── Operations ── */')[1]?.split('/* ── Beta ── */')[0] || '';
const app = fs.readFileSync(path.join(root, 'App.tsx'), 'utf8');
const sessions = fs.readFileSync(path.join(root, 'stores/session-store.ts'), 'utf8');

describe('AI Services navigation', () => {
  it('keeps AI Services out of top tabs and exposes it in admin/settings menu only with capability', () => {
    expect(header).toContain("const aiServicesEnabled = useSettingsStore((s) => s.serverConfig?.aiServicesEnabled === true)");
    expect(agentFirstNav).not.toContain("key: 'ai-services'");
    expect(legacyNav).not.toContain("key: 'ai-services'");
    expect(operations).not.toContain('에이전트 외부 배포');
    expect(settingsManagement).toContain('{aiServicesEnabled && isOperatorOrAdmin && (');
    expect(settingsManagement).toContain("label={t('externalAgentDeployment')}");
    expect(settingsManagement).toContain("store.setActiveView('aiServices')");
  });

  it('mounts the operations home only when the full-VM capability is enabled', () => {
    expect(app).toContain("import('./features/ai-services/AIServiceHome')");
    expect(app).toContain("activeView === 'aiServices' && aiServicesEnabled");
    expect(app).toContain("if (!useSettingsStore.getState().serverConfig?.aiServicesEnabled) return");
    expect(app).toContain("if (!aiServicesEnabled && activeView === 'aiServices')");
    expect(sessions).toContain("'aiServices'");
  });
});
