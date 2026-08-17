// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bottomScrollTop, clampScrollTop, isNearBottom, restorePrependScrollTop } from './scrollPositionMath';

describe('conversation viewport scrollPositionMath', () => {
  it('calculates the valid bottom scrollTop', () => {
    expect(bottomScrollTop({ scrollHeight: 2_000, clientHeight: 700 })).toBe(1_300);
    expect(bottomScrollTop({ scrollHeight: 500, clientHeight: 700 })).toBe(0);
  });

  it('treats the viewport as pinned when it is within the bottom threshold', () => {
    expect(isNearBottom({ scrollTop: 1_225, scrollHeight: 2_000, clientHeight: 700 }, 80)).toBe(true);
    expect(isNearBottom({ scrollTop: 1_100, scrollHeight: 2_000, clientHeight: 700 }, 80)).toBe(false);
  });

  it('clamps impossible scrollTop values before DOM writes', () => {
    const metrics = { scrollHeight: 1_000, clientHeight: 300 };
    expect(clampScrollTop(-10, metrics)).toBe(0);
    expect(clampScrollTop(250, metrics)).toBe(250);
    expect(clampScrollTop(999, metrics)).toBe(700);
  });

  it('preserves the visible anchor after older messages are prepended', () => {
    const before = { scrollTop: 320, scrollHeight: 1_400 };
    const after = { scrollHeight: 2_600, clientHeight: 600 };

    expect(restorePrependScrollTop(before, after)).toBe(1_520);
  });

  it('does not move the viewport when a failed/empty prepend does not grow content', () => {
    const before = { scrollTop: 320, scrollHeight: 1_400 };
    const after = { scrollHeight: 1_400, clientHeight: 600 };

    expect(restorePrependScrollTop(before, after)).toBe(320);
  });
});
