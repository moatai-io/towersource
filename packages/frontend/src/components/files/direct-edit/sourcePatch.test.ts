import { describe, expect, it } from 'vitest';
import { locateTextInSource, normalizeEditableText, patchSourceRange } from './sourcePatch';

describe('patchSourceRange', () => {
  it('patches only the requested source range', () => {
    expect(patchSourceRange('hello **world**', 8, 13, 'Tower')).toBe('hello **Tower**');
  });

  it('throws on invalid ranges', () => {
    expect(() => patchSourceRange('abc', 3, 2, 'x')).toThrow(/invalid/i);
  });

  it('preserves content outside the patch', () => {
    expect(patchSourceRange('<p>Hello</p><p>World</p>', 3, 8, 'Hi')).toBe('<p>Hi</p><p>World</p>');
  });
});

describe('normalizeEditableText', () => {
  it('normalizes non-breaking spaces from contentEditable', () => {
    expect(normalizeEditableText('A\u00a0B')).toBe('A B');
  });

  it('removes a trailing contentEditable newline', () => {
    expect(normalizeEditableText('Hello\n')).toBe('Hello');
  });
});

describe('locateTextInSource', () => {
  it('finds a unique source match', () => {
    expect(locateTextInSource({ source: '# Hello', text: 'Hello' })).toEqual({ start: 2, end: 7 });
  });

  it('returns ambiguous for repeated text without hints', () => {
    expect(locateTextInSource({ source: 'A\nHello\nB\nHello', text: 'Hello' })).toEqual({ error: 'ambiguous' });
  });

  it('uses hints to disambiguate repeated text', () => {
    expect(locateTextInSource({ source: 'A\nHello\nB\nHello', text: 'Hello', beforeHint: 'B' })).toEqual({ start: 10, end: 15 });
  });
});
