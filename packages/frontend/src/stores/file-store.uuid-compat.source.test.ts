import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const fileStore = fs.readFileSync(path.resolve(import.meta.dirname, './file-store.ts'), 'utf8');
const folderDrop = fs.readFileSync(path.resolve(import.meta.dirname, '../utils/folder-drop.ts'), 'utf8');

describe('HTTP-IP browser UUID compatibility', () => {
  it('uses the secure-context-safe helper for file, system, and chat tabs', () => {
    expect(fileStore).toContain("import { generateUUID } from '../utils/uuid'");
    expect(fileStore.match(/id: generateUUID\(\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(fileStore).not.toContain('id: crypto.randomUUID()');
  });

  it('uses the same helper for folder upload ids', () => {
    expect(folderDrop).toContain("import { generateUUID } from './uuid'");
    expect(folderDrop).toContain('const uploadId = generateUUID()');
    expect(folderDrop).not.toContain('const uploadId = crypto.randomUUID()');
  });
});
