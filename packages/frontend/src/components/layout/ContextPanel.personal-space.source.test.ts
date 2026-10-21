import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./ContextPanel.tsx', import.meta.url), 'utf8');

describe('ContextPanel personal file guards', () => {
  it('reloads compare content through the Personal Space endpoint', () => {
    expect(source).toContain("openFile.path.startsWith('personal://')");
    expect(source).toContain('/api/personal-space/files/read?uri=');
  });

  it('does not expose workspace sharing for personal files', () => {
    expect(source).toContain('showShareModal && !isPersonalFile');
    expect(source).toContain('{!isPersonalFile && (');
  });

  it('keeps conditional personal and preview surfaces behind lazy imports', () => {
    for (const target of [
      '../files/ShareModal',
      '../files/HtmlPreviewSurface',
      '../files/UrlPreviewSurface',
      '../files/OpenUrlPreviewDialog',
      '../personal-space/PersonalTodoView',
      '../personal-space/PersonalMaterialsView',
      '../personal-space/PersonalArchiveView',
      '../personal-space/MobilePersonalDocumentsView',
    ]) {
      expect(source).toContain(`import('${target}')`);
      expect(source).not.toContain(`from '${target}'`);
    }
  });
});
