import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../features/navigation-sidebar/project-files/SidebarProjectFiles.tsx'),
  'utf8',
);

describe('Sidebar file-tree refresh stability', () => {
  it('applies only the newest overlapping tree refresh', () => {
    expect(source).toContain('const treeLoadGeneration = useRef(0)');
    expect(source).toContain('const generation = ++treeLoadGeneration.current');
    expect(source).toContain('if (generation !== treeLoadGeneration.current) return');
  });

  it('coalesces delayed refresh retries and invalidates work on unmount', () => {
    expect(source).toContain('const refreshRetryTimer = useRef<number | null>(null)');
    expect(source).toContain('window.clearTimeout(refreshRetryTimer.current)');
    expect(source).toContain('treeLoadGeneration.current += 1');
  });

  it('refreshes only the upload target directory when a folder receives a drop', () => {
    expect(source).toContain('const refreshUploadedDirectory = useCallback(async (targetDir?: string) => {');
    expect(source).toContain('if (entry.path === targetDir)');
    expect(source).toContain('onRefreshTree={refreshUploadedDirectory}');
  });
});
