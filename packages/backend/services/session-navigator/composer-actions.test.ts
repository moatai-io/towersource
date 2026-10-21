import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildComposerActions } from './composer-actions.js';

describe('composer actions', () => {
  it('returns two stable human-only actions without an AI recommendation', () => {
    const result = buildComposerActions({ latestAssistantText: 'Any response.', contextRevision: 12, language: 'ko' });
    expect(result.actions.map(action => action.id)).toEqual(['continue', 'replan']);
    expect(result.actions.map(action => action.label)).toEqual(['계속 진행', '내용 정리']);
    expect(result.actions[1]?.message).toContain('handoff 자료');
    expect(result.actions[1]?.message).toContain('추천 스킬');
    expect(result.recommendedActionId).toBeNull();
    expect(result.actions.every(action => action.autoEligible === false)).toBe(true);
    expect(result).not.toHaveProperty('shadowDecision');
  });

  it.each(['ko', 'en'])('keeps the %s server continue message identical to the frontend fallback', (language) => {
    const copy = JSON.parse(readFileSync(new URL(`../../../frontend/src/locales/${language}/chat.json`, import.meta.url), 'utf8'));
    const result = buildComposerActions({ latestAssistantText: 'Any response.', contextRevision: 3, language });
    const action = result.actions.find(action => action.id === 'continue');
    expect(action?.message).toBe(language === 'ko' ? '계속 진행' : 'Continue');
    expect(action?.message).toBe(action?.label);
    expect(action?.message).toBe(copy.continueRequest);
  });

  it('localizes the handoff choice', () => {
    const result = buildComposerActions({ latestAssistantText: 'Any response.', contextRevision: 2, language: 'en' });
    expect(result.actions.map(action => action.label)).toEqual(['Continue', 'Prepare handoff']);
    expect(result.actions[1]?.message).toContain('recommended skills');
  });
});
