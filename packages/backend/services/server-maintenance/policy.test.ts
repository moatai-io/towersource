import { describe, expect, it } from 'vitest';
import { diskLevel, shouldNotify } from './policy.js';
describe('server disk policy', () => {
  it('uses available space and exact GiB thresholds', () => {
    expect(diskLevel(19 * 2 ** 30)).toBe('critical');
    expect(diskLevel(20 * 2 ** 30)).toBe('warning');
    expect(diskLevel(50 * 2 ** 30)).toBe('normal');
  });
  it('deduplicates and emits escalation, recovery and daily reminders', () => {
    expect(shouldNotify('warning', 'warning', 100, 0)).toBe(false);
    expect(shouldNotify('critical', 'warning', 100, 0)).toBe(true);
    expect(shouldNotify('normal', 'warning', 100, 0)).toBe(true);
    expect(shouldNotify('warning', 'warning', 86400_000, 0)).toBe(true);
    expect(shouldNotify('normal', 'normal', 86400_000, 0)).toBe(false);
  });
});
