import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './HistoryPanel.tsx'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/en/history.json'), 'utf8'));
const ko = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/ko/history.json'), 'utf8'));

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

describe('Session History locale contract', () => {
  it('localizes relative time, project fallbacks, view modes, and task status', () => {
    expect(source).toContain("useTranslation('history')");
    expect(source).toContain("i18n.t('justNow', { ns: 'history' })");
    expect(source).toContain("t('unknownProject')");
    expect(source).toContain("t('recent')");
    expect(source).toContain("t(`status.${status}`");
  });

  it('ships matching English and Korean keys', () => {
    expect(leafPaths(en).sort()).toEqual(leafPaths(ko).sort());
  });
});
