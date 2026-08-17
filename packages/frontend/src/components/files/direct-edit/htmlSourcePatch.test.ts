import { describe, expect, it } from 'vitest';
import { buildHtmlDirectEditDocument, escapeHtmlTextForSource } from './htmlSourcePatch';

describe('escapeHtmlTextForSource', () => {
  it('escapes text replacement for HTML source text nodes', () => {
    expect(escapeHtmlTextForSource('A < B & C > D')).toBe('A &lt; B &amp; C &gt; D');
  });
});

describe('buildHtmlDirectEditDocument', () => {
  it('wraps visible text nodes with source ranges', () => {
    const source = '<h1 class="x">Hello</h1><p>World</p>';
    const doc = buildHtmlDirectEditDocument(source);

    expect(doc.ranges).toEqual([
      { id: 'html-text-0', start: 14, end: 19 },
      { id: 'html-text-1', start: 27, end: 32 },
    ]);
    expect(doc.html).toContain('data-source-start="14" data-source-end="19"');
    expect(doc.html).toContain('Hello</span></h1>');
  });

  it('does not wrap whitespace-only text nodes', () => {
    const doc = buildHtmlDirectEditDocument('<div>\n  <p>Hello</p>\n</div>');
    expect(doc.ranges).toHaveLength(1);
    expect(doc.ranges[0]).toMatchObject({ start: 11, end: 16 });
  });

  it('skips script and style contents', () => {
    const source = '<style>.x{color:red}</style><script>var label="Hello";</script><p>Hello</p>';
    const doc = buildHtmlDirectEditDocument(source);
    expect(doc.ranges).toEqual([{ id: 'html-text-0', start: 66, end: 71 }]);
  });

  it('injects direct-edit assets before closing head when present', () => {
    const doc = buildHtmlDirectEditDocument('<html><head><title>T</title></head><body><p>Hello</p></body></html>');
    expect(doc.html.indexOf('tower-html-direct-edit-style')).toBeLessThan(doc.html.indexOf('</head>'));
  });

  it('keeps attribute text untouched', () => {
    const source = '<button aria-label="Save">Save</button>';
    const doc = buildHtmlDirectEditDocument(source);
    expect(doc.ranges).toEqual([{ id: 'html-text-0', start: 26, end: 30 }]);
    expect(doc.html).toContain('aria-label="Save"');
  });
});
