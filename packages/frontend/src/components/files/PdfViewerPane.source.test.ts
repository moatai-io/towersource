import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const contextPanel = fs.readFileSync(path.resolve(import.meta.dirname, '../layout/ContextPanel.tsx'), 'utf8');
const fileViewer = fs.readFileSync(path.resolve(import.meta.dirname, './FileViewerPage.tsx'), 'utf8');
const fileTree = fs.readFileSync(path.resolve(import.meta.dirname, './FileTree.tsx'), 'utf8');
const fileOpenActions = fs.readFileSync(path.resolve(import.meta.dirname, '../../hooks/useFileOpenActions.ts'), 'utf8');
const links = fs.readFileSync(path.resolve(import.meta.dirname, '../../utils/file-path-links.ts'), 'utf8');

 describe('PDF Viewer Pane contract', () => {
  it('renders PDFs inside Tower instead of replacing the Viewer with a browser-tab notice', () => {
    expect(contextPanel).toContain('className="h-full w-full border-0 bg-white"');
    expect(fileViewer).toContain('className="h-full w-full border-0 bg-white"');
    expect(contextPanel).not.toContain("t('pdfOpensInBrowser')");
    expect(fileViewer).not.toContain("t('pdfOpensInBrowserTab')");
  });

  it('keeps desktop PDF clicks in-app but uses the top-level browser viewer on mobile', () => {
    expect(fileTree).not.toContain("window.open(buildPdfServeUrl(entry.path), '_blank'");
    expect(fileOpenActions).toContain('if (sessionStore.isMobile && !backgroundViewer)');
    expect(fileOpenActions).toContain('recordMobileDocumentRecent(path, options?.name);\n        openPdfInBrowserTab(path);\n        return;');
    expect(links).not.toContain("if (getFileExt(normalizedPath) === 'pdf') {\n    openPdfInBrowserTab(normalizedPath);");
  });

  it('does not spawn a browser tab for background PDF deliveries on mobile', () => {
    expect(fileOpenActions).toContain('if (sessionStore.isMobile && !backgroundViewer)');
    expect(fileOpenActions).toContain('forceNew: backgroundViewer');
    expect(fileOpenActions).toContain('backgroundSplit: backgroundViewer');
  });

  it('keeps explicit open-in-new-window support available', () => {
    expect(fileTree).toContain("if (action === 'openNewWindow')");
    expect(fileTree).toContain('buildPdfServeUrl(entry.path)');
  });
});
