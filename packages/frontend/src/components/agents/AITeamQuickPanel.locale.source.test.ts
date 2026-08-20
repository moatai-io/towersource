import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './AITeamQuickPanel.tsx'), 'utf8');
const locale = (language: 'en' | 'ko') => JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, `../../locales/${language}/layout.json`), 'utf8'),
);

describe('AI Team quick panel locale contract', () => {
  it('routes user-facing chrome and relative time through layout locale keys', () => {
    for (const key of [
      'ariaLabel', 'eyebrow', 'close', 'searchPlaceholder', 'searchResults', 'teammate',
      'conversation', 'noResults', 'continueWorking', 'recentConversations',
      'recentTeammates', 'newTeammate', 'manageAll',
    ]) {
      expect(source).toContain(`aiTeamQuickPanel.${key}`);
    }
    expect(source).toContain("t('aiTeamQuickPanel.time.justNow')");
    expect(source).toContain("t('aiTeamQuickPanel.time.hoursAgo', { count: hours })");
    expect(source).toContain("t('aiTeamQuickPanel.time.daysAgo', { count: Math.floor(hours / 24) })");
  });

  it('keeps English and Korean key trees aligned', () => {
    const english = locale('en').aiTeamQuickPanel;
    const korean = locale('ko').aiTeamQuickPanel;
    expect(Object.keys(english).sort()).toEqual(Object.keys(korean).sort());
    expect(Object.keys(english.time).sort()).toEqual(Object.keys(korean.time).sort());
  });
});
