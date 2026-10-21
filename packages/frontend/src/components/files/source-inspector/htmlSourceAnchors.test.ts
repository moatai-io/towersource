import { describe, expect, it } from 'vitest';
import { buildHtmlSourceInspectorDocument } from './htmlSourceAnchors';

describe('buildHtmlSourceInspectorDocument', () => {
  it('maps full HTML elements to offsets in the original source', () => {
    const source = '<main><section class="hero"><h1>Hello</h1></section></main>';
    const result = buildHtmlSourceInspectorDocument(source, 'nonce-1');

    expect(result.anchors.map(({ tagName, start, end, lineStart, lineEnd, source: slice }) => ({
      tagName, start, end, lineStart, lineEnd, slice,
    }))).toEqual([
      { tagName: 'main', start: 0, end: source.length, lineStart: 1, lineEnd: 1, slice: source },
      {
        tagName: 'section',
        start: source.indexOf('<section'),
        end: source.indexOf('</section>') + '</section>'.length,
        lineStart: 1,
        lineEnd: 1,
        slice: '<section class="hero"><h1>Hello</h1></section>',
      },
      {
        tagName: 'h1',
        start: source.indexOf('<h1>'),
        end: source.indexOf('</h1>') + '</h1>'.length,
        lineStart: 1,
        lineEnd: 1,
        slice: '<h1>Hello</h1>',
      },
    ]);
    expect(result.html).toContain('<section class="hero" data-tower-source-anchor="html-element-1" data-tower-source-line-start="1" data-tower-source-line-end="1">');
    expect(result.html).toContain('const nonce = "nonce-1";');
  });

  it('keeps offsets correct for multiline Korean and emoji content', () => {
    const source = '<div>\n  <p>안녕하세요 👋</p>\n</div>';
    const result = buildHtmlSourceInspectorDocument(source, 'nonce-2');
    const paragraph = result.anchors.find((anchor) => anchor.tagName === 'p');

    expect(paragraph).toMatchObject({ lineStart: 2, lineEnd: 2 });
    expect(paragraph?.source).toBe('<p>안녕하세요 👋</p>');
    expect(source.slice(paragraph?.start, paragraph?.end)).toBe(paragraph?.source);
  });

  it('skips document shell and unbounded element ranges', () => {
    const source = `<html><body><main>${'x'.repeat(4_001)}</main><p>Small</p></body></html>`;
    const result = buildHtmlSourceInspectorDocument(source, 'nonce-shell');

    expect(result.anchors.map((anchor) => anchor.tagName)).toEqual(['p']);
  });

  it('does not expose script, style, or parser-generated elements as anchors', () => {
    const source = '<style>.x{color:red}</style><script>document.body.append("x")</script><p>Visible</p>';
    const result = buildHtmlSourceInspectorDocument(source, 'nonce-3');

    expect(result.anchors.map((anchor) => anchor.tagName)).toEqual(['p']);
    expect(result.html).not.toContain('<script data-tower-source-anchor');
    expect(result.html).not.toContain('<style data-tower-source-anchor');
  });

  it('uses parser source locations for optional closing tags', () => {
    const source = '<ul>\n<li>One\n<li>Two\n</ul>';
    const result = buildHtmlSourceInspectorDocument(source, 'nonce-4');
    const listItems = result.anchors.filter((anchor) => anchor.tagName === 'li');

    expect(listItems).toHaveLength(2);
    expect(listItems[0].source).toBe('<li>One\n');
    expect(listItems[1].source).toBe('<li>Two\n');
  });

  it('injects source attributes without changing original source slices', () => {
    const source = '<button aria-label="A > B">Save</button>';
    const result = buildHtmlSourceInspectorDocument(source, 'nonce-5');
    const button = result.anchors[0];

    expect(button.source).toBe(source);
    expect(result.html).toContain('aria-label="A > B" data-tower-source-anchor="html-element-0"');
  });

  it('inserts preview attributes before a self-closing slash', () => {
    const source = '<picture><img src="x.png" /></picture>';
    const result = buildHtmlSourceInspectorDocument(source, 'nonce-6');

    expect(result.html).toContain('src="x.png" data-tower-source-anchor="html-element-1" data-tower-source-line-start="1" data-tower-source-line-end="1" />');
    expect(result.html).not.toContain('/ data-tower-source-anchor');
  });
});
