import { describe, expect, it } from 'vitest';
import { getTourDefinition } from './tourRegistry';

describe('Tower beginner guide', () => {
  it('covers the core first-use scenes in a practical order', () => {
    const tour = getTourDefinition('beginner');
    expect(tour).not.toBeNull();

    const ids = tour?.steps.map((step) => step.id) ?? [];
    expect(ids).toEqual([
      'menu',
      'nav',
      'sidebar',
      'chat-input',
      'workspace-tabs',
      'agent-create',
    ]);
  });

  it('opens only the AI team scene for a target that is not initially visible', () => {
    const steps = getTourDefinition('beginner')?.steps ?? [];
    const scenes = steps.filter((step) => step.scene).map((step) => [step.id, step.scene]);

    expect(scenes).toEqual([['agent-create', 'ai-team-home']]);
  });

  it('reflects the current agent-first navigation and progressive teammate onboarding', () => {
    const steps = getTourDefinition('beginner')?.steps ?? [];
    const copy = steps.map((step) => `${step.title} ${step.description}`).join('\n');

    expect(copy).toContain('AI 팀');
    expect(copy).toContain('채널');
    expect(copy).toContain('AI Team');
    expect(copy).toContain('Work');
    expect(copy).toContain('선택지를 질문');
    expect(copy).toContain('더블클릭');
    expect(copy).toContain('우클릭');
    expect(copy).toContain('이름과 기대하는 전문성');
    expect(copy).toContain('합류 후');
    expect(copy).not.toContain('내 할 일');
    expect(copy).not.toContain('필요한 도구와 권한');
  });
});
