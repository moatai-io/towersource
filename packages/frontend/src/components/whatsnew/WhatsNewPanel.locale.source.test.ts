import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './WhatsNewPanel.tsx'), 'utf8');
const locale = (lang: 'en' | 'ko') => JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, `../../locales/${lang}/layout.json`), 'utf8'));

describe("What's New panel locale contract", () => {
  it('localizes panel chrome and the unseen badge', () => {
    expect(source).toContain("t('common:back')");
    expect(source).toContain("t('common:close')");
    expect(source).toContain("t('whatsNew.title')");
    expect(source).toContain("t('whatsNew.empty')");
    expect(source).toContain("t('whatsNew.newBadge')");
    expect(source).not.toContain('aria-label="Back"');
    expect(source).not.toContain('aria-label="Close"');
  });

  it('keeps English and Korean Whats New keys aligned', () => {
    expect(Object.keys(locale('en').whatsNew).sort()).toEqual(Object.keys(locale('ko').whatsNew).sort());
  });
});
