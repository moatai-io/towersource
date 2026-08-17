import { describe, expect, it } from 'vitest';
import { decodeExchangeDrag, encodeExchangeDrag } from './fileExchange';

describe('File Exchange drag codec', () => {
  it('round-trips a versioned opaque personal ref', () => {
    const payload = { version: 1 as const, source: { scope: 'personal' as const, uri: 'personal://files/a.pdf' }, name: 'a.pdf' };
    expect(decodeExchangeDrag(encodeExchangeDrag(payload))).toEqual(payload);
  });

  it('rejects raw-path and unversioned payloads', () => {
    expect(decodeExchangeDrag(JSON.stringify({ path: '/home/user/secret' }))).toBeNull();
    expect(decodeExchangeDrag('not-json')).toBeNull();
  });
});
