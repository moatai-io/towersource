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


describe('skill asset access guidance', () => {
  it.each(['operator-host', 'project-executor', 'unavailable'] as const)('distinguishes %s without claiming mount verification', async (execution) => {
    mockGetCommandsForUser.mockResolvedValueOnce([{
      name: '/issue', canonical: '/issue', fullContent: '# issue',
      dispatch: { type: 'skill', target: 'issue' },
    }]);
    const { createSkillsReadTool } = await import('./pi-skill-tools.js');
    const resolver = vi.fn().mockResolvedValue(execution);
    const tool = createSkillsReadTool({ resolveAssetExecution: resolver });
    const result = JSON.parse(readText(await (tool as any).execute('tc', { name: 'issue' })));
    expect(resolver).toHaveBeenCalledOnce();
    expect(result.assetAccess).toMatchObject({ execution, status: execution === 'operator-host' ? 'blocked' : 'unverified', bodyOnly: true });
    expect(result.assetAccess.managedRuntimePath).toBe(execution === 'project-executor' ? '/workspace/.tower/skills/issue/' : null);
    expect(result.assetAccess.safety).toContain('Never fabricate replacement references');
  });

  it('does not resolve assets for an invisible skill', async () => {
    mockGetCommandsForUser.mockResolvedValueOnce([]);
    const resolver = vi.fn();
    const { createSkillsReadTool } = await import('./pi-skill-tools.js');
    const result = await (createSkillsReadTool({ resolveAssetExecution: resolver }) as any).execute('tc', { name: 'hidden' });
    expect(result.isError).toBe(true);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('does not construct a runtime path from traversal in a registry target', async () => {
    mockGetCommandsForUser.mockResolvedValueOnce([{
      name: '/issue', canonical: '/issue', fullContent: '# issue',
      dispatch: { type: 'skill', target: '../outside' },
    }]);
    const { createSkillsReadTool } = await import('./pi-skill-tools.js');
    const tool = createSkillsReadTool({ resolveAssetExecution: async () => 'project-executor' });
    const result = JSON.parse(readText(await (tool as any).execute('tc', { name: 'issue' })));
    expect(result.assetAccess.managedRuntimePath).toBeNull();
  });
});
