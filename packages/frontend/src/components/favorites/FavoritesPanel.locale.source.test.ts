import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './FavoritesPanel.tsx'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/en/layout.json'), 'utf8'));
const ko = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/ko/layout.json'), 'utf8'));

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

describe('Favorites locale contract', () => {
  it('localizes headings, empty state, metadata, actions, and dates', () => {
    expect(source).toContain("useTranslation('layout')");
    expect(source).toContain("t('favoritesView.title')");
    expect(source).toContain("t('favoritesView.emptyTitle')");
    expect(source).toContain("i18n.t('favoritesView.noDate'");
    expect(source).toContain("title={t('favoritesView.remove')}");
  });

  it('ships matching English and Korean keys', () => {
    expect(leafPaths(en.favoritesView).sort()).toEqual(leafPaths(ko.favoritesView).sort());
  });
});
