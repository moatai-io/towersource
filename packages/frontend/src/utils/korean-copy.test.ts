import { describe, expect, it } from 'vitest';
import { formatNamedItem } from './korean-copy';

describe('particle-free Korean copy', () => {
  it.each([
    '업무',
    '사용',
    '홍길동',
    '보고서',
    '파일',
    'Skill',
    'Tower',
    'pi',
    '보고서-2026.07',
    '자료📎',
  ])('wraps %s with a fixed noun instead of guessing its pronunciation', (value) => {
    expect(formatNamedItem(value)).toBe(`"${value}" 항목`);
  });
});
