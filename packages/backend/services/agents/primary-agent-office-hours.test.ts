import { describe, expect, it } from 'vitest';
import { buildPrimaryAgentOfficeHoursInstruction } from './primary-agent-office-hours.js';

describe('Primary Agent first-day onboarding instruction', () => {
  it('starts real collaboration without repeating the hiring interview or presuming automation', () => {
    const text = buildPrimaryAgentOfficeHoursInstruction('고객 업무를 이해하고 자동화 후보를 찾기');
    expect(text).toContain('채용 면접의 연장이 아니라 첫 출근');
    expect(text).toContain('왜 저를 뽑았나요?');
    expect(text).toContain('사용자의 첫 실제 메시지에 당신이 직접 답합니다');
    expect(text).toContain('의례적인 자기소개를 앞세우지 말고');
    expect(text).not.toContain('인재팀에서 전달받은');
    expect(text).toContain('오늘 바로 같이 해볼 일');
    expect(text).toContain('자동화는 온보딩의 목표가 아니라');
    expect(text).toContain('AskUserQuestion은 실제 선택이 필요하고');
    expect(text).toContain('질문은 한 번에 하나');
    expect(text).toContain('ONBOARDING.md');
    expect(text).toContain('인수인계와 협업 계약');
    expect(text).toContain('실제 일을 함께');
  });
});
