import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prompt: vi.fn(async () => 'Tower shared policy'),
  reload: vi.fn(async () => {}),
  registry: vi.fn(async () => [{ name: 'agent-collaboration' }]),
}));
vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/synthetic/agent',
  DefaultResourceLoader: class {
    constructor(public options: any) {}
    reload = mocks.reload;
  },
}));
vi.mock('../../services/system-prompt.js', () => ({ buildSystemPrompt: mocks.prompt }));
vi.mock('../../services/pm/project-access.js', () => ({ resolveSessionProjectRoot: () => '/synthetic/project' }));
vi.mock('../../services/pm/project-agent-profile.js', () => ({
  getSessionProjectAgentRuntimeProfile: async () => null,
  getDisabledSkillsForAgentProfile: () => new Set(),
}));
vi.mock('../../services/skill/skill-registry.js', () => ({
  hasProjectManagedSkillManifest: () => true,
  getMaterializedSkillPaths: async () => ['/synthetic/project/.tower/skills'],
  getSkillsForSession: mocks.registry,
}));
import { buildPiSessionResources } from './session-resources.js';

async function build(overrides = {}) {
  return buildPiSessionResources({
    sessionId: 'child-session',
    opts: { userId: 1, username: 'test-user', userRole: 'member', cwd: '/synthetic/project', projectId: 'project', systemPromptFragments: ['agent-orchestration'] } as any,
    model: { contextWindow: 200_000 }, projectName: 'Synthetic',
    harness: { id: 'test', version: 1, engine: 'pi', prompt: {
      fragments: [], includeAgentIdentity: true, includeMemory: false,
      includeProjectInstructions: true, includeSkills: true, ...overrides,
    } } as any,
  });
}

describe('child-style Pi resource assembly (mocked provider and registry)', () => {
  beforeEach(() => vi.clearAllMocks());
  it('passes child identity and collaboration fragment and appends shared policy', async () => {
    const result = await build();
    expect(mocks.prompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'child-session', projectId: 'project', userId: 1,
      optionalFragments: expect.arrayContaining(['agent-orchestration']),
    }));
    const options = (result.resourceLoader as any).options;
    expect(options.appendSystemPrompt.join('\n')).toContain('Tower shared policy');
    expect(options.agentsFilesOverride).toBeUndefined();
    expect(options.additionalSkillPaths).toEqual(['/synthetic/project/.tower/skills']);
    expect(options.skillsOverride({ skills: [{ name: 'agent-collaboration', filePath: '/synthetic/project/.tower/skills/agent-collaboration/SKILL.md' }, { name: 'unavailable', filePath: '/outside/SKILL.md' }], diagnostics: [] }).skills)
      .toEqual([{ name: 'agent-collaboration', filePath: '/synthetic/project/.tower/skills/agent-collaboration/SKILL.md' }]);
    expect(mocks.reload).toHaveBeenCalledOnce();
  });
  it('honors explicit Harness exclusions instead of silently restoring skills or project identity', async () => {
    const result = await build({ includeAgentIdentity: false, includeProjectInstructions: false, includeSkills: false });
    expect(mocks.prompt).toHaveBeenCalledWith(expect.objectContaining({ projectId: undefined, sessionId: undefined }));
    const options = (result.resourceLoader as any).options;
    expect(options.noSkills).toBe(true);
    expect(options.skillsOverride).toBeUndefined();
    expect(options.agentsFilesOverride()).toEqual({ agentsFiles: [] });
    expect(mocks.registry).not.toHaveBeenCalled();
    expect(options.appendSystemPrompt.join('\n')).toContain('Tower shared policy');
  });
});

it('isolates secretary resources from cwd instructions, skills and extensions', async () => {
  vi.clearAllMocks();
  const result=await buildPiSessionResources({sessionId:'private',opts:{userId:7,userRole:'member',cwd:'/synthetic/project',secretaryConversation:true,serviceIdentityPrompt:'Private secretary'} as any,model:{contextWindow:200000},projectName:'',harness:{id:'test',version:1,engine:'pi',prompt:{fragments:[],includeAgentIdentity:true,includeMemory:true,includeProjectInstructions:true,includeSkills:true}} as any});
  const options=(result.resourceLoader as any).options;
  expect(options.noSkills).toBe(true);expect(options.noExtensions).toBe(true);
  expect(options.agentsFilesOverride()).toEqual({agentsFiles:[]});
  expect(options.additionalSkillPaths).toEqual([]);
  expect(result.memoryContext).toBeNull();expect(mocks.registry).not.toHaveBeenCalled();
});
