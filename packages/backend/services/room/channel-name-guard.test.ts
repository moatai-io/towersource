import { describe, expect, it } from 'vitest';
import { normalizeChannelName } from './room-manager.js';

describe('channel name identity guard', () => {
  it('normalizes case, outer whitespace, and repeated inner whitespace', () => {
    expect(normalizeChannelName('  TownHall   Korea  ')).toBe('townhall korea');
  });

  it('preserves meaningful punctuation while normalizing the human label', () => {
    expect(normalizeChannelName('영업-파트너')).toBe('영업-파트너');
  });
});
