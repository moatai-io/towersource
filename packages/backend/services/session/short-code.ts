/**
 * Owns: 세션 short_code 생성·판별 — URL 안에서 raw UUID 노출을 줄이는 8자 토큰.
 * Public API: generateShortCode, isShortCode, isUuid, SHORT_CODE_ALPHABET, SHORT_CODE_LENGTH.
 * See README of this folder + workspace/decisions/2026-05-24-url-routing-phase-2-short-code.md.
 *
 * 알파벳: 31자 base32 (모호 문자 `0/o`, `1/l/i`, `u` 제외 — 오독·욕설 회피)
 * 길이: 8 → 공간 31^8 ≈ 8.5×10^11 (수만 세션 대비 충돌 무시 가능)
 * 의존성: stdlib `crypto` 만 — nanoid 등 외부 패키지 추가하지 않음.
 */

import { randomBytes } from 'crypto';

export const SHORT_CODE_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';
export const SHORT_CODE_LENGTH = 8;

const ALPHABET_LEN = SHORT_CODE_ALPHABET.length; // 31

/**
 * 8자 short_code 생성. 균등분포 가까운 rejection sampling.
 * 256 % 31 = 8 이므로 248..255 구간을 버린다 (modulo bias 제거).
 *
 * 충돌 검사·재시도는 호출자(session-manager) 책임 — DB 의 unique index 위반 시 재호출.
 */
export function generateShortCode(): string {
  let out = '';
  // 넉넉히 뽑아 reject 해도 8자 채울 만큼: 32바이트 충분 (실패 확률 무시 가능)
  while (out.length < SHORT_CODE_LENGTH) {
    const buf = randomBytes(32);
    for (let i = 0; i < buf.length && out.length < SHORT_CODE_LENGTH; i++) {
      const b = buf[i];
      // 248..255 (rejection band) — 다음 바이트로 넘어감
      if (b >= 248) continue;
      out += SHORT_CODE_ALPHABET[b % ALPHABET_LEN];
    }
  }
  return out;
}

const SHORT_CODE_REGEX = new RegExp(`^[${SHORT_CODE_ALPHABET}]{${SHORT_CODE_LENGTH}}$`);

/** 입력이 short_code 형식인지 (8자, 알파벳 안). 소문자 고정. */
export function isShortCode(s: string): boolean {
  return SHORT_CODE_REGEX.test(s);
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 입력이 UUID v4 형식인지 (하이픈 포함 36자). */
export function isUuid(s: string): boolean {
  return UUID_REGEX.test(s);
}
