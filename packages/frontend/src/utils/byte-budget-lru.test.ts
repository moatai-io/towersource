import { describe, expect, it } from 'vitest';
import { ByteBudgetLru } from './byte-budget-lru';

describe('ByteBudgetLru', () => {
  const makeCache = (maxBytes = 10, maxEntries = 10) => new ByteBudgetLru<string, string>({
    maxBytes,
    maxEntries,
    estimateSize: (value) => value.length,
  });

  it('evicts the least recently used value when the byte budget is exceeded', () => {
    const cache = makeCache(8);
    cache.set('a', 'aaaa');
    cache.set('b', 'bbbb');
    expect(cache.get('a')).toBe('aaaa');

    cache.set('c', 'cccc');

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.totalBytes).toBe(8);
  });

  it('also enforces the entry ceiling', () => {
    const cache = makeCache(100, 2);
    cache.set('a', 'a');
    cache.set('b', 'b');
    cache.set('c', 'c');

    expect([...cache.keys()]).toEqual(['b', 'c']);
  });

  it('replaces an existing value without double-counting bytes', () => {
    const cache = makeCache(20);
    cache.set('a', 'aaaa');
    cache.set('a', 'aa');

    expect(cache.totalBytes).toBe(2);
    expect(cache.size).toBe(1);
  });

  it('does not retain an entry larger than the full budget', () => {
    const cache = makeCache(4);
    cache.set('large', '12345');

    expect(cache.has('large')).toBe(false);
    expect(cache.totalBytes).toBe(0);
  });
});
