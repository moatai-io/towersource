import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { containsInlineMarkdownSyntax } from './sourcePatch';

const source = readFileSync(new URL('./MarkdownDirectEditSurface.tsx', import.meta.url), 'utf8');

describe('MarkdownDirectEditSurface inline Markdown safety', () => {
  it('detects inline Markdown blocks that must not use plaintext fallback patching', () => {
    expect(containsInlineMarkdownSyntax('긴 **글** 의 끝을 수정')).toBe(true);
    expect(containsInlineMarkdownSyntax('긴 *글* 의 끝을 수정')).toBe(true);
    expect(containsInlineMarkdownSyntax('문장 안 `code` 수정')).toBe(true);
    expect(containsInlineMarkdownSyntax('문장 안 [link](https://example.com) 수정')).toBe(true);
  });

  it('does not block plain Markdown blocks from direct-edit fallback', () => {
    expect(containsInlineMarkdownSyntax('일반 문장의 끝을 수정')).toBe(false);
    expect(containsInlineMarkdownSyntax('- 체크리스트가 아닌 일반 텍스트')).toBe(false);
  });

  it('disables block-inner fallback before locating editable direct-edit ranges', () => {
    expect(source).toContain('if (containsInlineMarkdownSyntax(raw)) return null;');
    expect(source).not.toContain('inline Markdown 표식은 저장 시 평문으로 정리될 수 있음');
  });
});
