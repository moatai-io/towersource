import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./MobileTabBar.tsx', import.meta.url), 'utf8');

describe('retired Mobile Channel tab', () => {
  it('removes Channel from both mobile information architectures', () => {
    expect(source).not.toContain("{ id: 'channel'");
    expect(source).not.toContain('tabIcons.channel');
    expect(source).not.toContain("setActiveView('rooms')");
    expect(source).not.toContain("setSidebarTab('rooms')");
    expect(source).toContain('const visibleTabs = tabs');
    expect(source).toContain('setAiNavigationSurface()');
    expect(source).toContain('setMobileFilesNavigationSurface()');
  });
});
