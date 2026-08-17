import { describe, expect, it } from 'vitest';
import { decodeTextBuffer, detectDeclaredTextCharset, normalizeTextCharset } from './text-encoding.js';

describe('workspace text encoding helpers', () => {
  it('normalizes Korean legacy charset aliases to a supported decoder label', () => {
    expect(normalizeTextCharset('cp949')).toBe('euc-kr');
    expect(normalizeTextCharset('MS949')).toBe('euc-kr');
    expect(normalizeTextCharset('ks_c_5601-1987')).toBe('euc-kr');
  });

  it('detects legacy charset declarations in HTML meta tags', () => {
    const buffer = Buffer.from('<html><head><meta charset="cp949"></head><body></body></html>', 'latin1');
    expect(detectDeclaredTextCharset(buffer)).toBe('euc-kr');
  });

  it('decodes cp949/euc-kr Korean HTML bytes without replacement glyphs', () => {
    const buffer = Buffer.from([
      ...Buffer.from('<html><head><meta charset="euc-kr"></head><body>', 'ascii'),
      0xc7, 0xd1, 0xb1, 0xdb,
      ...Buffer.from('</body></html>', 'ascii'),
    ]);

    const decoded = decodeTextBuffer(buffer);

    expect(decoded.charset).toBe('euc-kr');
    expect(decoded.content).toContain('한글');
    expect(decoded.content).not.toContain('�');
  });

  it('keeps valid UTF-8 content as UTF-8', () => {
    const decoded = decodeTextBuffer(Buffer.from('<p>한글 UTF-8</p>', 'utf8'));

    expect(decoded.charset).toBe('utf-8');
    expect(decoded.content).toContain('한글 UTF-8');
  });
});
