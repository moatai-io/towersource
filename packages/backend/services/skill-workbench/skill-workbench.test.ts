import { describe, expect, it } from 'vitest';
import { buildSkillWorkbenchPrompt, isSkillWorkbenchEnabled, scoreSkillWorkbenchOutput } from './skill-workbench.js';
import { config } from '../../config.js';

describe('skill-workbench', () => {
  it('is enabled only on full VM role', () => {
    const original = config.towerRole;
    try {
      (config as any).towerRole = 'full';
      expect(isSkillWorkbenchEnabled()).toBe(true);
      (config as any).towerRole = 'managed';
      expect(isSkillWorkbenchEnabled()).toBe(false);
      (config as any).towerRole = 'standalone';
      expect(isSkillWorkbenchEnabled()).toBe(false);
    } finally {
      (config as any).towerRole = original;
    }
  });

  it('does not inject skill instructions for skill-off arm', () => {
    const built = buildSkillWorkbenchPrompt({ prompt: 'Write a headline' });
    expect(built.prompt).toBe('Write a headline');
    expect(built.systemPrompt).toContain('No Tower skill instructions');
    expect(built.systemPrompt).not.toContain('<skill');
  });

  it('injects bounded skill instructions for draft/baseline arms', () => {
    const built = buildSkillWorkbenchPrompt({
      prompt: 'Write a headline',
      skillName: 'great-copy',
      skillContent: 'Use concrete customer moments.',
    });
    expect(built.systemPrompt).toContain('<skill name="great-copy">');
    expect(built.systemPrompt).toContain('Use concrete customer moments.');
    expect(built.systemPrompt).not.toContain('No Tower skill instructions');
  });

  it('bounds long user prompts and skill content', () => {
    const built = buildSkillWorkbenchPrompt({
      prompt: 'p'.repeat(13_000),
      skillName: 'long-skill',
      skillContent: 's'.repeat(25_000),
    });
    expect(built.prompt.length).toBeLessThan(12_200);
    expect(built.prompt).toContain('[truncated:');
    expect(built.systemPrompt).toContain('[truncated:');
    expect(built.systemPrompt.length).toBeLessThan(25_000);
  });

  it('scores empty/error outputs lower than concrete structured outputs', () => {
    const empty = scoreSkillWorkbenchOutput('', 'failed');
    const concrete = scoreSkillWorkbenchOutput('1. 고객 사례를 기준으로 3주 안에 실행하세요.\n\n다만 비용 리스크를 먼저 확인해야 합니다.');
    expect(empty.total).toBe(0);
    expect(concrete.total).toBeGreaterThan(empty.total);
    expect(concrete.rubric.map((r) => r.id)).toContain('specificity');
  });
});
