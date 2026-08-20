import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHANGELOG, changelogLanguage } from '../../data/changelog';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './WhatsNewModal.tsx'), 'utf8');

describe('WhatsNewModal locale contract', () => {
  it('selects localized changelog copy from the active i18n language', () => {
    expect(source).toContain('changelogLanguage(i18n.resolvedLanguage || i18n.language)');
    expect(source).toContain('latest.title[language]');
    expect(source).toContain('item.text[language]');
  });

  it('defaults unsupported languages to English and preserves Korean', () => {
    expect(changelogLanguage('en-US')).toBe('en');
    expect(changelogLanguage('fr')).toBe('en');
    expect(changelogLanguage('ko-KR')).toBe('ko');
  });

  it('ships aligned English and Korean copy for every changelog entry', () => {
    for (const entry of CHANGELOG) {
      expect(entry.title.en).toBeTruthy();
      expect(entry.title.ko).toBeTruthy();
      for (const item of entry.items) {
        expect(item.text.en).toBeTruthy();
        expect(item.text.ko).toBeTruthy();
      }
    }
  });
});
