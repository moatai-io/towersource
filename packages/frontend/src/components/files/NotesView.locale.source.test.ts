import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './NotesView.tsx'), 'utf8');
const locale = (lang: 'en' | 'ko') => JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, `../../locales/${lang}/files.json`), 'utf8'));

describe('NotesView locale contract', () => {
  it('routes search and document states through files locale keys', () => {
    for (const key of ['searchPlaceholder', 'clear', 'loading', 'empty', 'loadFailed']) {
      expect(source).toContain(`notesView.${key}`);
    }
    expect(source).not.toContain('placeholder="문서 파일명이나 폴더 검색"');
  });

  it('keeps English and Korean notes keys aligned', () => {
    expect(Object.keys(locale('en').notesView).sort()).toEqual(Object.keys(locale('ko').notesView).sort());
  });
});
