import { describe, expect, it } from 'vitest';
import { getLatestSessionDismissKey, isLatestSessionDismissed } from './latest-session-persistence';

describe('latest session dismissal', () => {
  const session = { id: 'session-1', updatedAt: '2026-07-10T12:00:00.000Z' };

  it('keeps the current session update dismissed even while callers report it running', () => {
    const keys = new Set([getLatestSessionDismissKey(session)]);
    expect(isLatestSessionDismissed(keys, session)).toBe(true);
  });

  it('allows a genuinely newer session update to appear again', () => {
    const keys = new Set([getLatestSessionDismissKey(session)]);
    expect(isLatestSessionDismissed(keys, { ...session, updatedAt: '2026-07-10T12:05:00.000Z' })).toBe(false);
  });
});
