import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const share = fs.readFileSync(path.resolve(import.meta.dirname, './SessionShareModal.tsx'), 'utf8');
const item = fs.readFileSync(path.resolve(import.meta.dirname, './SessionItem.tsx'), 'utf8');
const related = fs.readFileSync(path.resolve(import.meta.dirname, './RelatedSessionsPopover.tsx'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/en/layout.json'), 'utf8'));
const ko = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/ko/layout.json'), 'utf8'));

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

describe('session surfaces locale contract', () => {
  it('connects share, list, and related-session UI to layout translations', () => {
    expect(share).toContain("useTranslation('layout')");
    expect(share).toContain("t('sessionShare.title')");
    expect(item).toContain('t("restoreNormalContext")');
    expect(item).toContain("t('answerNeeded')");
    expect(related).toContain("useTranslation('layout')");
    expect(related).toContain("t('noRelatedSessions')");
  });

  it('ships matching English and Korean share keys', () => {
    expect(leafPaths(en.sessionShare).sort()).toEqual(leafPaths(ko.sessionShare).sort());
    for (const key of ['awaitingAnswer', 'aiQuestionNeedsAnswer', 'restoreNormalContext', 'useLongContext', 'relatedSessionsLoadFailed', 'noRelatedSessions']) {
      expect(en[key], `missing English layout key: ${key}`).toBeTruthy();
      expect(ko[key], `missing Korean layout key: ${key}`).toBeTruthy();
    }
  });
});
