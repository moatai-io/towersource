import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workspace = fs.readFileSync(path.resolve(import.meta.dirname, './FilesWorkspace.tsx'), 'utf8');
const tree = fs.readFileSync(path.resolve(import.meta.dirname, './FileTree.tsx'), 'utf8');

describe('Agent file transfer destination contract', () => {
  it('removes internal-link copy actions from Agent Home file menus', () => {
    expect(workspace).not.toContain('copySelectedLinks');
    expect(workspace).not.toContain("t('workspace.copyInternalLink')");
    expect(tree).not.toContain("action: 'copyInternalLink'");
  });

  it('lets the user browse a selected Agent workspace before copying', () => {
    expect(workspace).toContain('loadTransferDirectories');
    expect(workspace).toContain('navigateTransferDirectory');
    expect(workspace).toContain('transferDirectory.slice(target.rootPath.length)');
    expect(workspace).toContain("t('workspace.transferMessageWithPath'");
  });
});
