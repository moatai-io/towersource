import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => fs.readFileSync(path.resolve(import.meta.dirname, name), 'utf8');
const hook = read('./useInlineEdit.ts');
const diff = read('./DiffPreview.tsx');
const injector = read('./htmlInjector.ts');
const surface = read('../HtmlInlineEditSurface.tsx');
const locale = (lang: 'en' | 'ko') => JSON.parse(read(`../../../locales/${lang}/files.json`));

describe('inline edit locale contract', () => {
  it('routes errors, diff labels, counts, and iframe selection labels through files locale keys', () => {
    for (const key of ['selectionNotFound', 'selectionAmbiguous', 'editFailed', 'undoFailed', 'saveFailed']) {
      expect(hook).toContain(`inlineEditErrors.${key}`);
    }
    expect(diff).toContain("t('inlineEditDiff.before')");
    expect(diff).toContain("t('inlineEditDiff.after')");
    expect(diff).toContain("t('inlineEditDiff.characterCount'");
    expect(surface).toContain("t('inlineEditOutline.selection')");
    expect(injector).not.toContain("buildOutlineDiv('selection', selectionRect, '선택')");
  });

  it('keeps English and Korean inline edit locale structures aligned', () => {
    const en = locale('en');
    const ko = locale('ko');
    for (const group of ['inlineEditErrors', 'inlineEditDiff', 'inlineEditOutline']) {
      expect(Object.keys(en[group]).sort()).toEqual(Object.keys(ko[group]).sort());
    }
  });
});
