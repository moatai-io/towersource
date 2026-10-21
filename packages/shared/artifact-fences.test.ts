import { describe, expect, it } from 'vitest';
import { parseArtifactFences } from './artifact-fences';

describe('artifact envelope fences', () => {
  const body = '# Report\n\n```mermaid\nflowchart LR\n A["A"] --> B["B"]\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```json\n{"value":1}\n```\n\nEnd';
  it('preserves internal Mermaid, tables and code through the final closing fence', () => {
    const raw = 'Before\n```tower-artifact path="work/test.md"\n' + body + '\n```\nAfter';
    const [match] = parseArtifactFences(raw);
    expect(match.body).toBe(body);
    expect(raw.slice(match.end)).toBe('\nAfter');
  });
  it('does not materialize a partial streaming envelope at an inner fence', () => {
    const raw = '```tower-artifact path="work/test.md"\n' + body + '\n```';
    for (let n = 0; n < raw.length; n++) expect(parseArtifactFences(raw.slice(0, n), true)).toEqual([]);
    expect(parseArtifactFences(raw)).toHaveLength(1);
  });
  it('supports longer outer fences with unlabelled inner code and CRLF', () => {
    const text = '```\r\ncode\r\n```\r\n~~~text\r\nmore\r\n~~~';
    expect(parseArtifactFences('````tower-artifact path="work/a.md"\r\n' + text + '\r\n````')[0].body).toBe(text);
  });
  it('keeps inline backticks and handles multiple envelopes', () => {
    const item = '```tower-artifact path="work/a.md"\ninline ``` here\n```';
    expect(parseArtifactFences(item + '\n' + item).map(m => m.body)).toEqual(['inline ``` here', 'inline ``` here']);
  });
});
