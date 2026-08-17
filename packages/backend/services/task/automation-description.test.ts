import { describe, expect, it } from 'vitest';
import { buildDefaultAutomationDescription } from './automation-manager.js';

describe('buildDefaultAutomationDescription', () => {
  it('keeps an explicit human description', () => {
    expect(buildDefaultAutomationDescription({
      name: '결정문서 INDEX 자동 갱신',
      description: '매일 새 결정문서를 반영해 INDEX를 최신 상태로 유지합니다.',
      prompt: 'Run /decisions-distill',
      triggerType: 'cron',
      cronConfig: { type: 'daily', hour: 3, minute: 0 },
    })).toBe('매일 새 결정문서를 반영해 INDEX를 최신 상태로 유지합니다.');
  });

  it('uses description-like metadata from definitionJson before falling back to prompt', () => {
    expect(buildDefaultAutomationDescription({
      name: '데일리 브리핑',
      prompt: 'Long raw prompt that should not become the description',
      definitionJson: { purpose: '매일 아침 프로젝트 상황을 요약합니다.' },
      triggerType: 'cron',
      cronConfig: { type: 'weekdays', hour: 9, minute: 30 },
    })).toBe('매일 아침 프로젝트 상황을 요약합니다.');
  });

  it('creates a useful Korean default when no description is supplied', () => {
    expect(buildDefaultAutomationDescription({
      name: '리포트 생성',
      prompt: 'Generate a detailed report',
      jobType: 'ai_prompt',
      triggerType: 'cron',
      cronConfig: { type: 'daily', hour: 8, minute: 5 },
    })).toBe('리포트 생성 스케줄입니다. 매일 8:05에 실행됩니다. 작업 종류는 AI 프롬프트 작업입니다.');
  });
});
