import { describe, expect, it } from 'vitest';
import { safeAutomationContext } from './automation-context.js';
describe('automation reference minimization', () => {
  it('retains bounded business intent without markup or links', () => {
    expect(safeAutomationContext('매일 경쟁사 요금제를 비교하고 변경 내용을 알려주세요.')).toContain('요금제');
    expect(safeAutomationContext('https://example.com 문서 확인')).not.toContain('https:');
    expect(safeAutomationContext('a'.repeat(900))).toHaveLength(600);
  });
  it('omits fields with secret and contact signals before external inference', () => {
    for (const text of ['API_KEY=synthetic', 'Bearer synthetic', '비밀번호 예시', 'send to demo@example.com', 'https://example.com?q=secret']) expect(safeAutomationContext(text)).toBe('');
  });
});
