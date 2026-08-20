import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'SelectionToolbar.tsx'), 'utf8');

describe('SelectionToolbar locale contract', () => {
  it('routes copy, delete, and move feedback through files locale keys', () => {
    for (const key of [
      'selection.copied',
      'selection.deleteOne',
      'selection.deleteMany',
      'selection.deleted',
      'selection.deleteFailed',
      'selection.moved',
      'selection.moveFailed',
    ]) expect(source).toContain(key);
  });

  it('preserves compact top-level paths and file operation API boundaries', () => {
    expect(source).toContain('compactTopLevelPaths');
    expect(source).toContain("apiPost('/api/files/delete'");
    expect(source).toContain("apiPost('/api/files/rename'");
  });
});
