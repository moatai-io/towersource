import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const documents = fs.readFileSync(path.resolve(import.meta.dirname, './MobilePersonalDocumentsView.tsx'), 'utf8');
const archive = fs.readFileSync(path.resolve(import.meta.dirname, './PersonalArchiveView.tsx'), 'utf8');
const picker = fs.readFileSync(path.resolve(import.meta.dirname, './PersonalNotePicker.tsx'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/en/layout.json'), 'utf8'));
const ko = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/ko/layout.json'), 'utf8'));

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

describe('personal materials locale contract', () => {
  it('connects document, archive, and note picker surfaces to layout translations', () => {
    expect(documents).toContain("t('personalDocuments.loading')");
    expect(documents).toContain('i18n.resolvedLanguage || i18n.language');
    expect(archive).toContain("t('personalArchive.title')");
    expect(picker).toContain("useTranslation('layout')");
    expect(picker).toContain("t('personalNotePicker.title')");
  });

  it('ships matching English and Korean locale trees', () => {
    for (const section of ['personalDocuments', 'personalArchive', 'personalNotePicker']) {
      expect(leafPaths(en[section]).sort()).toEqual(leafPaths(ko[section]).sort());
    }
  });
});
