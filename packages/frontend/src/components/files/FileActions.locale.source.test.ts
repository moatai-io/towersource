import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rich = fs.readFileSync(path.resolve(__dirname, '../shared/RichContent.tsx'), 'utf8');
const tree = fs.readFileSync(path.resolve(__dirname, 'FileTree.tsx'), 'utf8');

describe('file action locale contract', () => {
  it('routes RichContent file path actions and feedback through files locale keys', () => {
    for (const key of [
      'files:richContent.pathCopied',
      'files:richContent.savePersonalFailed',
      'files:richContent.pathMenu',
      'files:richContent.openNewTab',
      'files:richContent.savePersonal',
      'files:richContent.revealFile',
      'files:richContent.copyFailedFallback',
    ]) expect(rich).toContain(key);
  });

  it('preserves browser open, personal file upload, clipboard, and sidebar reveal behavior', () => {
    expect(rich).toContain('openTowerFileInBrowserTab(filePath)');
    expect(rich).toContain("fetch('/api/personal-space/files/upload'");
    expect(rich).toContain('navigator.clipboard.writeText(normalizedPath)');
    expect(rich).toContain('revealTowerFileInSidebar(filePath)');
  });

  it('routes FileTree paste and delete results through files locale keys without changing APIs', () => {
    expect(tree).toContain("tFiles('tree.pasted'");
    expect(tree).toContain("tFiles('tree.deleteFailed'");
    expect(tree).toContain("apiPost('/api/files/copy'");
    expect(tree).toContain("apiPost('/api/files/delete'");
  });
});
