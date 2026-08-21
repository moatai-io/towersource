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

  it('finishes at the persistent Agent rail creation entry point', () => {
    const steps = getTourDefinition('beginner')?.steps ?? [];
    const agentStep = steps.find((step) => step.id === 'agent-create');

    expect(agentStep?.target).toBe('[data-tour-id="agent-rail-create"]');
    expect(agentStep?.scene).toBeUndefined();
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
