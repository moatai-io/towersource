import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const INBOX_PATH = path.resolve(import.meta.dirname, './InboxPanel.tsx');

describe('InboxPanel Latest contracts', () => {
  it('shares the persisted sidebar session filters with Latest', () => {
    const src = fs.readFileSync(INBOX_PATH, 'utf-8');
    expect(src).toContain('loadSessionListFilters');
    expect(src).toContain('matchesSessionListFilters');
    expect(src).toContain('SESSION_LIST_FILTERS_UPDATED_EVENT');
  });

  it('offers dismiss-from-Latest even while a card is running', () => {
    const src = fs.readFileSync(INBOX_PATH, 'utf-8');
    expect(src).toContain("aria-label={t('pendingRepliesView.dismiss')}");
    expect(src).not.toMatch(/isUnread\s*&&\s*\(\s*<button onClick=\{onDismiss\}/);
    expect(src).not.toMatch(/!isStreaming\s*&&\s*\(\s*<button onClick=\{onDismiss\}/);
  });
});
