import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, 'App.tsx'), 'utf8');

describe('folder path navigation', () => {
  it('routes directory links through the current AI teammate file workspace reveal flow', () => {
    const start = source.indexOf('if (isDirectoryLikeTowerPath(path))');
    const end = source.indexOf("if (getFileExt(path) === 'pdf')", start);
    const directoryBranch = source.slice(start, end);

    expect(directoryBranch).toContain("new CustomEvent('tower-reveal-tab-target'");
    expect(directoryBranch).toContain("detail: { kind: 'file', path: normalizedDir }");
    expect(directoryBranch).not.toContain("setSidebarTab('files')");
    expect(directoryBranch).not.toContain('data-sidebar-file-path');
  });
});
