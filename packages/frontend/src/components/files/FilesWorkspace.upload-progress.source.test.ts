import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './FilesWorkspace.tsx'), 'utf8');
const chatSource = fs.readFileSync(path.resolve(import.meta.dirname, '../chat/InputBox.tsx'), 'utf8');

describe('FilesWorkspace upload progress contract', () => {
  it('reuses the compact progress chip and forwards real upload progress', () => {
    expect(source).toContain('UploadProgressChip');
    expect(source).toContain('uploadDroppedFiles(targetPath, items, setUploadProgress)');
    expect(source).toContain('uploadProgress && <UploadProgressChip');
    expect(chatSource).toContain('<UploadProgressChip progress={uploadProgress} />');
  });
});
