import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync(path.resolve(import.meta.dirname, '../../App.tsx'), 'utf8');
const fileOpenActions = fs.readFileSync(path.resolve(import.meta.dirname, '../../hooks/useFileOpenActions.ts'), 'utf8');
const contextPanel = fs.readFileSync(path.resolve(import.meta.dirname, './ContextPanel.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.resolve(import.meta.dirname, './Sidebar.tsx'), 'utf8');
const sidebarFilesSurface = fs.readFileSync(path.resolve(import.meta.dirname, './SidebarFilesSurface.tsx'), 'utf8');
const styles = fs.readFileSync(path.resolve(import.meta.dirname, '../../index.css'), 'utf8');

describe('mobile Markdown document experience', () => {
  it('uses a true fullscreen overlay instead of squeezing the document between app chrome', () => {
    expect(app).toContain('fixed inset-0 z-[100] flex flex-col bg-surface-950');
    expect(app).not.toContain('fixed left-0 right-0 top-12 bottom-16 z-40');
  });

  it('offers a direct read/edit action and mobile document typography', () => {
    expect(contextPanel).toContain("const isMobileDocument = Boolean(onMobileClose && openFile.language === 'markdown')");
    expect(contextPanel).toContain("setContextPanelTab(isWriteMode ? 'preview' : 'write')");
    expect(contextPanel).toContain("'mobile-markdown-document'");
    expect(styles).toContain('.mobile-markdown-document {');
    expect(styles).toContain('font-size: 17px;');
  });

  it('removes the file tab strip from mobile and records documents for recent-file re-entry', () => {
    expect(app).toMatch(/<ContextPanel[\s\S]*?hideTabBar[\s\S]*?onMobileClose/);
    expect(fileOpenActions).toContain('recordMobileDocumentRecent(path, options?.name)');
    expect(app).not.toContain('activeViewerTab && !mobileContextOpen');
    expect(app).not.toContain('열어둔 문서 다시 열기');
  });

  it('closes the mobile sidebar after direct Home or Files navigation', () => {
    expect(sidebar).toContain("rememberAgentWorkspaceLocation(project.id, 'home');");
    expect(sidebarFilesSurface).toContain("rememberAgentWorkspaceLocation(project.id, 'files');");
    expect(sidebar).toContain("if (useSessionStore.getState().isMobile) useSessionStore.getState().setSidebarOpen(false);");
    expect(sidebarFilesSurface).toContain("setMobileProjectPickerOpen(false);");
  });
});
