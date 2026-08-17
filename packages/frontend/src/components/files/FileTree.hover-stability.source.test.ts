import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './FileTree.tsx'), 'utf8');

describe('FileTree hover stability', () => {
  it('keeps the low-frequency favorite action in the context menu instead of the pointer row', () => {
    expect(source).toContain("action: 'pin' as MenuAction");
    expect(source).toContain('Pinning remains available from the context menu');
    expect(source).not.toContain('group-hover:opacity-100 group-hover:pointer-events-auto');
  });
});
