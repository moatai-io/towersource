import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./PersonalNotePicker.tsx', import.meta.url), 'utf8');

describe('PersonalNotePicker source contract', () => {
  it('lists owner-scoped personal files and supports search', () => {
    expect(source).toContain("fetch('/api/personal-space/files'");
    expect(source).toContain('개인 노트 이름이나 경로 검색');
    expect(source).toContain('note.relativePath');
  });

  it('offers both open and create flows', () => {
    expect(source).toContain('onOpen(note.uri)');
    expect(source).toContain('+ 새 개인 노트');
  });
});
