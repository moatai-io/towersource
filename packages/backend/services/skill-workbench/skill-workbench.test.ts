import { describe, expect, it, vi } from 'vitest';
import { buildSkillWorkbenchPrompt, isSkillWorkbenchEnabled, runSkillWorkbenchComparison, scoreSkillWorkbenchOutput } from './skill-workbench.js';
import { config, getModelDefaults } from '../../config.js';
import { runUtilityTextTask } from '../ai/utility-agent.js';

vi.mock('../ai/utility-agent.js', () => ({ runUtilityTextTask: vi.fn(async () => 'Synthetic comparison output.') }));

describe('skill-workbench', () => {
  it('uses Core for all three comparison arms without saving history or calling a provider', async () => {
    const originalRole = config.towerRole;
    const originalFlag = process.env.SKILL_WORKBENCH_ENABLED;
    vi.mocked(runUtilityTextTask).mockClear();
    try {
      (config as any).towerRole = 'full';
      process.env.SKILL_WORKBENCH_ENABLED = 'true';
      const result = await runSkillWorkbenchComparison({ prompt: 'Synthetic task', saveToHistory: false });
      expect(result.runs).toHaveLength(3);
      expect(runUtilityTextTask).toHaveBeenCalledTimes(3);
      for (const [request] of vi.mocked(runUtilityTextTask).mock.calls) {
        expect(request.model).toBe(getModelDefaults().session);
      }
    } finally {
      (config as any).towerRole = originalRole;
      if (originalFlag === undefined) delete process.env.SKILL_WORKBENCH_ENABLED;
      else process.env.SKILL_WORKBENCH_ENABLED = originalFlag;
    }
  });
  it('stays off by default and requires an explicit full-VM opt-in', () => {
    const originalRole = config.towerRole;
    const originalFlag = process.env.SKILL_WORKBENCH_ENABLED;
    try {
      (config as any).towerRole = 'full';
      delete process.env.SKILL_WORKBENCH_ENABLED;
      expect(isSkillWorkbenchEnabled()).toBe(false);
      process.env.SKILL_WORKBENCH_ENABLED = 'false';
      expect(isSkillWorkbenchEnabled()).toBe(false);
      process.env.SKILL_WORKBENCH_ENABLED = 'true';
      expect(isSkillWorkbenchEnabled()).toBe(true);
      (config as any).towerRole = 'managed';
      expect(isSkillWorkbenchEnabled()).toBe(false);
      (config as any).towerRole = 'standalone';
      expect(isSkillWorkbenchEnabled()).toBe(false);
    } finally {
      (config as any).towerRole = originalRole;
      if (originalFlag === undefined) delete process.env.SKILL_WORKBENCH_ENABLED;
      else process.env.SKILL_WORKBENCH_ENABLED = originalFlag;
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
