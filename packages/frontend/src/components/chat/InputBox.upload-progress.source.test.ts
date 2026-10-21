import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './InputBox.tsx'), 'utf8');
const chipSource = fs.readFileSync(path.resolve(import.meta.dirname, '../common/UploadProgressChip.tsx'), 'utf8');

describe('InputBox compact upload progress contract', () => {
  it('keeps upload progress in the attachment chip row instead of a full-width card', () => {
    expect(source).toContain('Upload progress, file attachments, and source references');
    expect(source).toContain('<UploadProgressChip progress={uploadProgress} />');
    expect(chipSource).toContain('inline-flex h-9 max-w-[220px]');
    expect(chipSource).toContain("progress.phase === 'processing' ? t('uploadProgress.saving')");
    expect(chipSource).toContain('absolute inset-x-0 bottom-0 h-0.5');
    expect(source).not.toContain('서버에서 파일을 저장하는 중…');
    expect(source).not.toContain('mx-3 mt-2.5 rounded-xl');
  });
});
