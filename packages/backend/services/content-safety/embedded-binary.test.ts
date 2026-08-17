import { describe, expect, it } from 'vitest';
import { sanitizeEmbeddedBinaryText } from './embedded-binary.js';

describe('sanitizeEmbeddedBinaryText', () => {
  it('removes a large SVG data URI payload while preserving layout attributes', () => {
    const payload = 'A'.repeat(9000);
    const source = `<image x="12" href="data:image/png;base64,${payload}" width="640"/>`;
    const result = sanitizeEmbeddedBinaryText(source);

    expect(result).toContain('<image x="12"');
    expect(result).toContain('data:image/png;base64,[embedded binary omitted: image/png');
    expect(result).toContain('encodedChars=9000');
    expect(result).toContain('width="640"/>');
    expect(result).not.toContain(payload);
  });

  it('removes a large standalone base64-like run', () => {
    const payload = 'Q'.repeat(9000);
    const result = sanitizeEmbeddedBinaryText(`before ${payload} after`);
    expect(result).toMatch(/^before \[embedded binary omitted: base64, encodedChars=9000, sha256=[a-f0-9]{16}\] after$/);
  });

  it('keeps small data URIs unchanged', () => {
    const source = 'url(data:image/png;base64,QUJDRA==)';
    expect(sanitizeEmbeddedBinaryText(source)).toBe(source);
  });
});
