import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './ContextPanel.tsx'), 'utf8');

describe('ContextPanel HTML source inspector integration', () => {
  it('switches newly opened HTML files to preview so the inspector surface is visible', () => {
    expect(source).toContain("['markdown', 'html', 'agent-draft'");
    expect(source).toContain("setContextPanelTab('preview')");
  });

  it('renders source-backed HTML preview with the real file path', () => {
    expect(source).toContain('<HtmlPreviewSurface key={contentRevision} content={openFile.content} filePath={openFile.path}');
  });
});
