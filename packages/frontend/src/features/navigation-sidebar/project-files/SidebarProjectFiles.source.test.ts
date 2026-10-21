import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./SidebarProjectFiles.tsx', import.meta.url), 'utf8');

describe('SidebarProjectFiles initial loading', () => {
  it('loads the active project immediately without a per-project stagger', () => {
    expect(source).toContain('if (isExpanded) void loadTree(loaded.current);');
    expect(source).not.toContain('staggerDelay');
    expect(source).not.toContain('Math.abs(hash) % 400');
  });

  it('renders root entries early only on the first load', () => {
    const rootFetch = source.indexOf('const rootEntries = await fetchDir(rootPath);');
    const firstRender = source.indexOf('if (!loaded.current) setEntries(rootEntries);', rootFetch);
    const rehydrate = source.indexOf('const filled = await fillExpanded(rootEntries, expandedPaths, !!force);', rootFetch);

    expect(rootFetch).toBeGreaterThan(-1);
    expect(firstRender).toBeGreaterThan(rootFetch);
    expect(firstRender).toBeLessThan(rehydrate);
    expect(source).toContain('if (generation === treeLoadGeneration.current) setLoading(false);');
    expect(source).toContain("setLoadError(error instanceof Error ? error.message : 'Could not load files')");
  });
});
