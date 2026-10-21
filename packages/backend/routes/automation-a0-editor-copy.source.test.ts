import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');

function routeBody(path: string, nextPath: string): string {
  const start = source.indexOf(`router.post('${path}'`);
  const end = source.indexOf(`router.post('${nextPath}'`, start + 1);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Automation A0 editor onboarding', () => {
  it('states that conditional AI and custom reporting cannot be applied by the v1 editor', () => {
    const editor = routeBody('/automations/:id/editor-thread', '/automations/:id/editor-thread-message');
    expect(editor).toContain('조건부 AI·맞춤 보고처럼 아직 예약 실행에 연결되지 않은 요청은 적용 불가로 안내');
    expect(editor).toContain('30분마다 실행 중인 자동화를 15분마다');
    expect(editor).not.toContain('3번 연속 실패하면 알려줘');
    expect(editor).not.toContain('정상/실패/경고 상황에서 언제 조용히 넘어가고 언제 알려줄지 정리');
  });

  it('short-circuits unsupported instructions before either LLM edit call', () => {
    const thread = routeBody('/automations/:id/editor-thread-message', '/automations/:id/suggest-yaml-edit');
    const suggestion = routeBody('/automations/:id/suggest-yaml-edit', '/automations/:id/apply-yaml');
    for (const body of [thread, suggestion]) {
      expect(body).toContain('isUnsupportedAutomationYamlInstructionV1(instruction)');
      expect(body.indexOf('isUnsupportedAutomationYamlInstructionV1(instruction)')).toBeLessThan(body.indexOf('await runUtilityTextTask('));
    }
  });
});
