import { describe, expect, it } from 'vitest';
import { parseLooseJson } from './parse-loose-json';

describe('parseLooseJson — strict JSON', () => {
  it('parses valid strict JSON unchanged', () => {
    const r = parseLooseJson('{"a":1,"b":[2,3]}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ a: 1, b: [2, 3] });
  });

  it('handles native Korean strings without escapes', () => {
    const r = parseLooseJson('{"title":"안녕하세요","emoji":"🎉"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ title: '안녕하세요', emoji: '🎉' });
  });

  it('preserves valid \\uXXXX escapes (e.g. soft hyphen U+00AD)', () => {
    // raw JSON text contains backslash-u-0-0-a-d
    const r = parseLooseJson('{"s":"a\\u00adb"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.s).toBe('a­b');
  });
});

describe('parseLooseJson — loose cleanup', () => {
  it('strips trailing commas', () => {
    const r = parseLooseJson('{"a":1,"b":[2,3,],}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ a: 1, b: [2, 3] });
  });

  it('converts single-quoted strings', () => {
    const r = parseLooseJson("{'a':'hi'}");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ a: 'hi' });
  });
});

describe('parseLooseJson — bad \\u escape rescue', () => {
  it('rescues invalid \\uABCG (G is not hex) by preserving as literal', () => {
    // raw text: {"s":"\uABCG"} — strict JSON.parse throws "Bad Unicode escape"
    const raw = '{"s":"\\uABCG"}';
    const r = parseLooseJson(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.s).toBe('\\uABCG');
  });

  it('rescues truncated \\u200 (only 3 hex digits) at end of string', () => {
    const raw = '{"s":"prefix\\u200"}';
    const r = parseLooseJson(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.s).toBe('prefix\\u200');
  });

  it('rescues \\u followed by non-hex with valid content trailing', () => {
    const raw = '{"a":"x\\uZZZZy","b":2}';
    const r = parseLooseJson(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.a).toBe('x\\uZZZZy');
      expect(r.data.b).toBe(2);
    }
  });

  it('preserves valid \\u alongside invalid \\u in the same payload', () => {
    // ­ valid, \uXXXG invalid
    const raw = '{"good":"a\\u00adb","bad":"\\uXXXG"}';
    const r = parseLooseJson(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.good).toBe('a­b');
      expect(r.data.bad).toBe('\\uXXXG');
    }
  });
});
