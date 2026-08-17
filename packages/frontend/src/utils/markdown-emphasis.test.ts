import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { normalizeMarkdownEmphasisBoundaries } from './markdown-emphasis';

function paragraphChildTypes(markdown: string): string[] {
  const tree = unified().use(remarkParse).parse(markdown) as any;
  return tree.children[0].children.map((node: any) => node.type);
}

describe('normalizeMarkdownEmphasisBoundaries', () => {
  it('lets Korean suffixes follow bold phrases that end with quotes', () => {
    const input = '대체로 **“유한한 존재가 의미를 찾는 이야기”**였습니다.';

    expect(paragraphChildTypes(input)).toEqual(['text']);
    expect(paragraphChildTypes(normalizeMarkdownEmphasisBoundaries(input))).toContain('strong');
  });

  it('lets Korean suffixes follow bold phrases that end with punctuation', () => {
    const input = '결론은 **중요합니다.**입니다.';

    expect(paragraphChildTypes(input)).toEqual(['text']);
    expect(paragraphChildTypes(normalizeMarkdownEmphasisBoundaries(input))).toContain('strong');
  });

  it('does not touch fenced code blocks or inline code', () => {
    const input = [
      '본문 **“강조”**입니다.',
      '',
      '```md',
      '코드 **“그대로”**입니다.',
      '```',
      '',
      '인라인 `**“그대로”**입니다` 확인',
    ].join('\n');

    const output = normalizeMarkdownEmphasisBoundaries(input);

    expect(output).toContain('본문 **“강조”**&#8203;입니다.');
    expect(output).toContain('코드 **“그대로”**입니다.');
    expect(output).toContain('`**“그대로”**입니다`');
  });

  it('leaves already-parseable Korean strong emphasis unchanged', () => {
    const input = '이건 **중요**합니다.';

    expect(normalizeMarkdownEmphasisBoundaries(input)).toBe(input);
  });
});
