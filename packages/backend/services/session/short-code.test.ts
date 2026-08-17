/**
 * Tests for short-code.ts — 생성 형식, 알파벳, 충돌, 판별 함수.
 */

import { describe, it, expect } from 'vitest';
import {
  generateShortCode,
  isShortCode,
  isUuid,
  SHORT_CODE_ALPHABET,
  SHORT_CODE_LENGTH,
} from './short-code';

describe('generateShortCode', () => {
  it('정확히 8자', () => {
    for (let i = 0; i < 100; i++) {
      const code = generateShortCode();
      expect(code).toHaveLength(SHORT_CODE_LENGTH);
    }
  });

  it('알파벳 31자 안에서만', () => {
    const alphaSet = new Set(SHORT_CODE_ALPHABET.split(''));
    for (let i = 0; i < 100; i++) {
      const code = generateShortCode();
      for (const ch of code) {
        expect(alphaSet.has(ch)).toBe(true);
      }
    }
  });

  it('모호 문자 0/o, 1/l/i, u 미포함', () => {
    expect(SHORT_CODE_ALPHABET).not.toMatch(/[01loiu]/);
  });

  it('1만 회 생성에서 충돌 0', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      const code = generateShortCode();
      expect(seen.has(code)).toBe(false);
      seen.add(code);
    }
  });

  it('대문자·기호·공백 없음', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateShortCode();
      expect(code).toMatch(/^[a-z0-9]+$/);
    }
  });
});

describe('isShortCode', () => {
  it('생성된 code 는 모두 true', () => {
    for (let i = 0; i < 50; i++) {
      expect(isShortCode(generateShortCode())).toBe(true);
    }
  });

  it('UUID 는 false', () => {
    expect(isShortCode('2dcf72ae-c57e-4657-8c38-aaf6001c4a76')).toBe(false);
  });

  it('대문자 거부', () => {
    expect(isShortCode('K4M2P9XQ')).toBe(false);
  });

  it('금지 문자 (0,1,l,o,i,u) 거부', () => {
    expect(isShortCode('k4m0p9xq')).toBe(false); // 0
    expect(isShortCode('k4m1p9xq')).toBe(false); // 1
    expect(isShortCode('k4mlp9xq')).toBe(false); // l
    expect(isShortCode('k4mop9xq')).toBe(false); // o
    expect(isShortCode('k4mip9xq')).toBe(false); // i
    expect(isShortCode('k4mup9xq')).toBe(false); // u
  });

  it('길이 7 또는 9 거부', () => {
    expect(isShortCode('k4m2p9x')).toBe(false);
    expect(isShortCode('k4m2p9xqq')).toBe(false);
  });

  it('빈 문자열 거부', () => {
    expect(isShortCode('')).toBe(false);
  });
});

describe('isUuid', () => {
  it('표준 UUID v4 true', () => {
    expect(isUuid('2dcf72ae-c57e-4657-8c38-aaf6001c4a76')).toBe(true);
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it('대문자 hex 도 허용 (case-insensitive)', () => {
    expect(isUuid('2DCF72AE-C57E-4657-8C38-AAF6001C4A76')).toBe(true);
  });

  it('하이픈 없는 32자 거부', () => {
    expect(isUuid('2dcf72aec57e46578c38aaf6001c4a76')).toBe(false);
  });

  it('짧은 short_code 거부', () => {
    expect(isUuid('k4m2p9xq')).toBe(false);
  });

  it('빈 문자열 거부', () => {
    expect(isUuid('')).toBe(false);
  });
});
