import { describe, expect, it, vi } from 'vitest';

const mockGetCommandsForUser = vi.fn();

vi.mock('../services/skill/skill-registry.js', () => ({
  getCommandsForUser: mockGetCommandsForUser,
}));

function readText(result: any): string {
  return result?.content?.[0]?.text || '';
}

describe('Pi skill tools', () => {
  it('lists project-visible skills without full bodies', async () => {
    mockGetCommandsForUser.mockResolvedValueOnce([
      {
        name: 'meeting-prep',
        canonical: '/meeting-prep',
        aliases: ['/회의준비'],
        displayName: '회의 준비',
        description: '회의 준비 스킬',
        fullContent: '# Meeting Prep\nsecret body',
        source: 'skills',
        scope: 'project',
        risk: 'medium',
        dispatch: { type: 'skill', target: 'meeting-prep' },
      },
      {
        name: 'task',
        canonical: '/task',
        description: 'native',
        source: 'native',
        dispatch: { type: 'native', target: 'task.list' },
      },
    ]);
    const { createSkillsListTool } = await import('./pi-skill-tools.js');
    const tool = createSkillsListTool({ userId: 1, projectId: 'p1', cwd: '/x' });
    const result = await (tool as any).execute('tc1', { query: '회의' });
    const parsed = JSON.parse(readText(result));

    expect(parsed.total).toBe(1);
    expect(parsed.skills[0]).toMatchObject({ name: 'meeting-prep', displayName: '회의 준비' });
    expect(readText(result)).not.toContain('secret body');
  });

  it('reads one skill by alias with full SKILL.md content', async () => {
    mockGetCommandsForUser.mockResolvedValueOnce([
      {
        name: 'meeting-prep',
        canonical: '/meeting-prep',
        aliases: ['/회의준비'],
        displayName: '회의 준비',
        description: '회의 준비 스킬',
        fullContent: '# Meeting Prep\nUse this skill.',
        source: 'skills',
        scope: 'project',
        risk: 'medium',
        dispatch: { type: 'skill', target: 'meeting-prep' },
      },
    ]);
    const { createSkillsReadTool } = await import('./pi-skill-tools.js');
    const tool = createSkillsReadTool({ userId: 1, projectId: 'p1', cwd: '/x' });
    const result = await (tool as any).execute('tc1', { name: '/회의준비' });
    const parsed = JSON.parse(readText(result));

    expect(parsed).toMatchObject({ name: 'meeting-prep', displayName: '회의 준비' });
    expect(parsed.content).toContain('# Meeting Prep');
  });
});
