import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');

describe('Sidebar archived-session inclusion on mobile', () => {
  it('defaults includeArchived to off on mobile while desktop remembers the persisted setting', () => {
    expect(source).toContain(
      "useState(() => !isMobile && localStorage.getItem('sidebar-search-archived') === 'true')"
    );
  });

  it('persists the toggle only outside mobile layouts', () => {
    const toggle = source.slice(source.indexOf('const toggleIncludeArchived'));
    expect(toggle).toContain("if (!isMobile) localStorage.setItem('sidebar-search-archived', String(next));");
  });
});
