import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
const panel = fs.readFileSync(path.resolve(import.meta.dirname, './AITeamQuickPanel.tsx'), 'utf8');
const header = fs.readFileSync(path.resolve(import.meta.dirname, '../layout/Header.tsx'), 'utf8');
const app = fs.readFileSync(path.resolve(import.meta.dirname, '../../App.tsx'), 'utf8');

describe('AI Team navigation', () => {
  it('opens the conversation workspace from the primary AI tab', () => {
    expect(header).toContain("case 'ai':");
    expect(header).toContain('store.setAiNavigationSurface()');
    expect(header).toContain('store.setSidebarOpen(true)');
    expect(header).not.toContain('tower-toggle-ai-quick-panel');
  });

  it('keeps the optional quick panel implementation available but detached from the primary button', () => {
    expect(app).toContain('<AITeamQuickPanel');
    expect(app).toContain('aiQuickPanelOpen');
    expect(panel).toContain("t('aiTeamQuickPanel.manageAll')");
    expect(panel).toContain("t('aiTeamQuickPanel.searchPlaceholder')");
  });
});
