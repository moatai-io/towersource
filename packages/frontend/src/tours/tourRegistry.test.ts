import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { getTourDefinition } from './tourRegistry';

describe('Tower beginner guide', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); });
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

    expect(copy).toContain('AI Team');
    expect(copy).toContain('channels');
    expect(copy).toContain('Work');
    expect(copy).toContain('choices');
    expect(copy).toContain('Double-click');
    expect(copy).toContain('right-click');
    expect(copy).toContain('name and expected expertise');
    expect(copy).toContain('after the teammate joins');
    expect(copy).not.toContain('My Todo');

    return i18n.changeLanguage('ko').then(() => {
      const koreanCopy = getTourDefinition('beginner')?.steps.map((step) => `${step.title} ${step.description}`).join('\n') ?? '';
      expect(koreanCopy).toContain('AI 팀');
      expect(koreanCopy).toContain('선택지를 질문');
    });
  });
});
