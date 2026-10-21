import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const header = fs.readFileSync(path.resolve(import.meta.dirname, './Header.tsx'), 'utf8');
const mobile = fs.readFileSync(path.resolve(import.meta.dirname, './MobileTabBar.tsx'), 'utf8');

describe('Work history navigation', () => {
  it('removes the duplicate desktop and mobile Work tabs and their unread badges', () => {
    expect(header).not.toContain("{ key: 'work'");
    expect(mobile).not.toContain("{ id: 'work'");
    expect(header).not.toContain('workAttentionCount');
    expect(mobile).not.toContain('workAttentionCount');
  });

  it('keeps the global Work history menu entry wired to the Work view', () => {
    expect(header).toContain("label={t('workHistory')}");
    expect(header).toContain('testId="global-nav-work"');
    expect(header).toContain("store.setActiveView('work')");
  });
});
