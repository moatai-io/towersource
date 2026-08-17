import { describe, expect, it } from 'vitest';
import { formatCodeForPreview } from './codeFormatting';

describe('formatCodeForPreview', () => {
  it('pretty prints valid JSON without changing its data', async () => {
    const source = '{"nested":{"value":1},"items":[1,2]}';
    const formatted = await formatCodeForPreview(source, 'json');
    expect(formatted).toContain('\n  "nested"');
    expect(JSON.parse(formatted)).toEqual(JSON.parse(source));
  });

  it('formats supported code for display', async () => {
    const formatted = await formatCodeForPreview('const value={a:1,b:[2,3]}', 'javascript');
    expect(formatted).toContain('const value = { a: 1, b: [2, 3] };');
  });

  it('returns exact source for invalid or unsupported input', async () => {
    expect(await formatCodeForPreview('{broken', 'json')).toBe('{broken');
    expect(await formatCodeForPreview('a  b', 'plaintext')).toBe('a  b');
  });
});
