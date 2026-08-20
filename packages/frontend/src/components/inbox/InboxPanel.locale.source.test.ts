import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './InboxPanel.tsx'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/en/layout.json'), 'utf8'));
const ko = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/ko/layout.json'), 'utf8'));

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

describe('Pending Replies locale contract', () => {
  it('localizes the panel, cards, actions, and relative time', () => {
    expect(source).toContain("useTranslation('layout')");
    expect(source).toContain("t('pendingRepliesView.title')");
    expect(source).toContain("t('pendingRepliesView.replyPlaceholder')");
    expect(source).toContain("i18n.t('pendingRepliesView.justNow'");
  });

  it('ships matching English and Korean keys', () => {
    expect(leafPaths(en.pendingRepliesView).sort()).toEqual(leafPaths(ko.pendingRepliesView).sort());
  });
});
