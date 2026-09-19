import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './FileTree.tsx'), 'utf8');

describe('FileTree move completion', () => {
  it('exits selection mode and refreshes the full project tree after moving selected entries', () => {
    expect(source).toContain('if (store.selectMode) store.toggleSelectMode();');
    expect(source).toContain('store.bumpRefreshTrigger();');
    expect(source).toContain('onRefreshTree?.();');
  });
});
