import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOne = vi.fn();
const query = vi.fn();
const execute = vi.fn();
const createPrimaryAgentCommand = vi.fn();
const validatePrimaryAgentHarnessBinding = vi.fn();
const ensureProjectAgentInstruction = vi.fn();
const isProjectOwner = vi.fn();
vi.mock('../db/pg-repo.js', () => ({ queryOne, query, execute }));
vi.mock('../config.js', () => ({ config: { agentFirstEnabled: true } }));
vi.mock('../services/agents/primary-agent-creation.js', () => ({ createPrimaryAgentCommand }));
vi.mock('../services/agents/primary-agent-staffing.js', () => ({ validatePrimaryAgentHarnessBinding }));
vi.mock('../services/pm/project-agent-instruction.js', () => ({ ensureProjectAgentInstruction }));
vi.mock('../services/pm/project-membership-manager.js', () => ({ isProjectOwner }));

const { createPrimaryAgentProfileTools, createPrimaryAgentProjectTool, createPrimaryAgentStaffingTools } = await import('./pi-primary-agent-tools.js');
const staffing = {
  name: '전략 파트너', face: 'character:young-korean-1', tagline: '판단을 선명하게', role: '전략 담당', promise: '결정을 실행으로', instruction: '근거를 먼저 본다.', firstMission: '이번 분기 전략 정리',
  capabilityRequirements: { required: ['web.fetch', 'web.search'], forbidden: ['project.files.write'] },
  harnessBinding: { harnessId: 'quick-web-research', harnessVersion: 1, runtimeProfileId: 'web-only', runtimeProfileVersion: 1 },
};
const card = { ...staffing, confirmed: true, staffingHash: '' };

beforeEach(() => {
  vi.clearAllMocks();
  queryOne.mockResolvedValue({ system_key: 'ai-talent-team' });
  query.mockResolvedValue([]);
  isProjectOwner.mockResolvedValue(true);
  validatePrimaryAgentHarnessBinding.mockResolvedValue({
    harnessName: 'Quick Web Research', engine: 'pi', providedCapabilities: ['web.fetch', 'web.search'],
    requiredCapabilities: ['web.fetch', 'web.search'], missingRequired: [], forbiddenPresent: [],
  });
});

describe('create_primary_agent_project', () => {
  it('is unavailable outside Agent-first identity context', () => {
    expect(createPrimaryAgentProjectTool({ userId: 1 })).toBeNull();
  });

  it('recommends the least-privilege published Harness and flags missing custom needs', async () => {
    queryOne.mockResolvedValueOnce({ system_key: 'ai-talent-team' });
    query.mockResolvedValueOnce([
      { id: 'tower-default', name: 'Tower Default', description: '', current_version: 1, engine: 'pi', runtime_profile_id: 'standard', profile_version: 1, staffing_capability_ids: ['web.fetch', 'web.search', 'project.files.write'] },
      { id: 'quick-web-research', name: 'Quick Web Research', description: '', current_version: 1, engine: 'pi', runtime_profile_id: 'web-only', profile_version: 1, staffing_capability_ids: ['web.fetch', 'web.search'] },
    ]);
    const [recommend]: any = createPrimaryAgentStaffingTools({ userId: 1, userRole: 'member', projectId: 'talent' });
    const out = await recommend.execute('recommend', { requirements: staffing.capabilityRequirements });
    expect(query.mock.calls[0][0]).toContain('v.staffing_capability_ids');
    expect(out.isError).toBe(false);
    expect(out.content[0].text).toContain('"harnessId": "quick-web-research"');
    expect(out.content[0].text).toContain('"customHarnessRequired": false');
  });

  it('previews a complete Staffing Package with an approval hash', async () => {
    queryOne.mockResolvedValueOnce({ system_key: 'ai-talent-team' });
    const [, preview]: any = createPrimaryAgentStaffingTools({ userId: 1, userRole: 'member', projectId: 'talent' });
    const out = await preview.execute('preview', staffing);
    expect(out.isError).toBe(false);
    expect(out.content[0].text).toContain('"staffingHash"');
    expect(out.content[0].text).toContain('"harnessName": "Quick Web Research"');
  });

  it('refuses creation without explicit confirmation', async () => {
    const tool: any = createPrimaryAgentProjectTool({ userId: 1, userRole: 'member', projectId: 'talent' });
    const out = await tool.execute('call', { ...card, confirmed: false });
    expect(out.isError).toBe(true);
    expect(createPrimaryAgentCommand).not.toHaveBeenCalled();
  });

  it('refuses use outside the managed teammate-creation context', async () => {
    queryOne.mockResolvedValue({ system_key: null });
    const tool: any = createPrimaryAgentProjectTool({ userId: 1, userRole: 'member', projectId: 'other' });
    const out = await tool.execute('call', card);
    expect(out.isError).toBe(true);
    expect(createPrimaryAgentCommand).not.toHaveBeenCalled();
  });

  it('delegates the approved Staffing Package and selected Harness to the idempotent command service', async () => {
    queryOne.mockResolvedValueOnce({ system_key: 'ai-talent-team' });
    const [, preview]: any = createPrimaryAgentStaffingTools({ userId: 1, userRole: 'member', projectId: 'talent' });
    const previewOut = await preview.execute('preview', staffing);
    const previewData = JSON.parse(previewOut.content[0].text);

    createPrimaryAgentCommand.mockResolvedValue({ ok: true, commandId: 'c1', project: { id: 'p1', name: staffing.name }, session: { id: 's1', visibility: 'private' } });
    queryOne.mockResolvedValueOnce({ system_key: 'ai-talent-team' });
    const tool: any = createPrimaryAgentProjectTool({ userId: 1, userRole: 'member', projectId: 'talent' });
    const out = await tool.execute('call', { ...staffing, confirmed: true, staffingHash: previewData.staffingHash });
    expect(out.isError).toBe(false);
    expect(createPrimaryAgentCommand).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 1, sourceProjectId: 'talent', name: staffing.name, firstMission: staffing.firstMission,
      approvedCardHash: previewData.staffingHash,
      harnessBinding: staffing.harnessBinding,
    }));
    expect(out.content[0].text).toContain('"visibility": "private"');
  });

  it('rejects creation when the Staffing Package changed after preview', async () => {
    const tool: any = createPrimaryAgentProjectTool({ userId: 1, userRole: 'member', projectId: 'talent' });
    const out = await tool.execute('call', { ...staffing, role: '변조된 역할', confirmed: true, staffingHash: '0'.repeat(64) });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('changed after preview');
    expect(createPrimaryAgentCommand).not.toHaveBeenCalled();
  });

  it('reports command failure without archiving unrelated Projects', async () => {
    queryOne.mockResolvedValueOnce({ system_key: 'ai-talent-team' });
    const [, preview]: any = createPrimaryAgentStaffingTools({ userId: 1, userRole: 'member', projectId: 'talent' });
    const previewOut = await preview.execute('preview', staffing);
    const previewData = JSON.parse(previewOut.content[0].text);

    createPrimaryAgentCommand.mockRejectedValue(new Error('profile failed'));
    queryOne.mockResolvedValueOnce({ system_key: 'ai-talent-team' });
    const tool: any = createPrimaryAgentProjectTool({ userId: 1, userRole: 'member', projectId: 'talent' });
    const out = await tool.execute('call', { ...staffing, confirmed: true, staffingHash: previewData.staffingHash });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('profile failed');
    expect(execute).not.toHaveBeenCalledWith('UPDATE projects SET archived=1 WHERE id=$1', expect.anything());
  });

  it('lets a Project owner preview their current teammate profile without the helper context', async () => {
    const row = { root_path: '/workspace/project', instruction_version: 3, display_name: '기존', face: '✨', tagline: '기존 소개', role: '기존 역할', promise: '기존 약속', instruction: '기존 지침', authority_policy: {}, tool_policy: {} };
    queryOne.mockReset().mockResolvedValueOnce(row);
    const [preview]: any = createPrimaryAgentProfileTools({ userId: 1, userRole: 'member', projectId: 'p1' });
    const shown = await preview.execute('preview', { targetProjectId: 'p1', changes: { face: 'character:new' } });
    expect(shown.isError).toBe(false);
    expect(shown.content[0].text).toContain('character:new');
    expect(queryOne).toHaveBeenCalledTimes(1);
  });

  it('allows Project owners to preview their teammate profile from any accessible context', async () => {
    const row = { root_path: '/workspace/project', instruction_version: 2, display_name: '기존', face: '✨', tagline: '', role: '', promise: '', instruction: '기존', authority_policy: {}, tool_policy: {} };
    queryOne.mockReset().mockResolvedValueOnce(row);
    isProjectOwner.mockResolvedValueOnce(true);
    const [preview]: any = createPrimaryAgentProfileTools({ userId: 1, userRole: 'member', projectId: 'other' });
    const shown = await preview.execute('preview', { targetProjectId: 'p2', changes: { face: 'character:new' } });
    expect(shown.isError).toBe(false);
  });

  it('refuses Profile and AGENTS.md changes from non-owner members', async () => {
    isProjectOwner.mockResolvedValue(false);
    queryOne.mockClear();
    const [preview]: any = createPrimaryAgentProfileTools({ userId: 1, userRole: 'member', projectId: 'p1' });
    const shown = await preview.execute('preview', { targetProjectId: 'p1', changes: { face: 'character:new' } });
    expect(shown.isError).toBe(true);
    expect(shown.content[0].text).toContain('Only the Project owner');
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('previews and applies a versioned Profile update without changing Session snapshots', async () => {
    const row = { root_path: '/workspace/project', instruction_version: 3, display_name: '기존', face: '✨', tagline: '기존 소개', role: '기존 역할', promise: '기존 약속', instruction: '기존 지침', authority_policy: {}, tool_policy: {} };
    queryOne.mockReset().mockResolvedValueOnce(row);
    isProjectOwner.mockResolvedValue(true);
    const [preview]: any = createPrimaryAgentProfileTools({ userId: 1, userRole: 'member', projectId: 'talent' });
    const shown = await preview.execute('preview', { targetProjectId: 'p1', changes: { face: 'character:new', role: '새 역할' } });
    expect(shown.isError).toBe(false);
    expect(shown.content[0].text).toContain('existingSessionsKeepPinnedVersion');

    vi.clearAllMocks();
    queryOne.mockResolvedValueOnce(row);
    isProjectOwner.mockResolvedValue(true);
    execute.mockResolvedValue({ changes: 1 });
    const [, update]: any = createPrimaryAgentProfileTools({ userId: 1, userRole: 'member', projectId: 'talent' });
    const applied = await update.execute('update', { targetProjectId: 'p1', confirmed: true, expectedVersion: 3, changes: { face: 'character:new' } });
    expect(applied.isError).toBe(false);
    expect(applied.content[0].text).toContain('"profileVersion": 4');
    expect(ensureProjectAgentInstruction).toHaveBeenCalledWith('/workspace/project', expect.objectContaining({ face: 'character:new' }));
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('instruction_version=instruction_version+1'), expect.any(Array));
  });

  it('preserves the UI-managed Operator access flag when an AI profile update replaces authority policy', async () => {
    const row = {
      root_path: '/workspace/project', instruction_version: 3, display_name: '기존', face: '✨',
      tagline: '기존 소개', role: '기존 역할', promise: '기존 약속', instruction: '기존 지침',
      authority_policy: { superuser: true, externalActions: 'confirm' }, tool_policy: {},
    };
    queryOne.mockReset().mockResolvedValueOnce(row);
    isProjectOwner.mockResolvedValue(true);
    execute.mockResolvedValue({ changes: 1 });
    const [, update]: any = createPrimaryAgentProfileTools({ userId: 1, userRole: 'member', projectId: 'talent' });
    const applied = await update.execute('update', {
      targetProjectId: 'p1', confirmed: true, expectedVersion: 3,
      changes: { authorityPolicy: { externalActions: 'allow' } },
    });
    expect(applied.isError).toBe(false);
    const updateArgs = execute.mock.calls[0][1];
    expect(JSON.parse(updateArgs[6])).toEqual({ externalActions: 'allow', superuser: true });
  });

  it('prevents an AI profile update from changing the UI-managed Operator access flag', async () => {
    const row = {
      root_path: '/workspace/project', instruction_version: 3, display_name: '기존', face: '✨',
      tagline: '기존 소개', role: '기존 역할', promise: '기존 약속', instruction: '기존 지침',
      authority_policy: { superuser: true }, tool_policy: {},
    };
    queryOne.mockReset().mockResolvedValueOnce(row);
    isProjectOwner.mockResolvedValue(true);
    execute.mockResolvedValue({ changes: 1 });
    const [, update]: any = createPrimaryAgentProfileTools({ userId: 1, userRole: 'member', projectId: 'talent' });
    const response = await update.execute('update', {
      targetProjectId: 'p1', confirmed: true, expectedVersion: 3,
      changes: { authorityPolicy: { superuser: false } },
    });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('AGENT_EXECUTION_AUTHORITY_RESERVED');
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a Profile update when AGENTS.md cannot be synchronized', async () => {
    const row = { root_path: '/workspace/project', instruction_version: 1, display_name: '기존', face: '✨', tagline: '', role: '', promise: '', instruction: '기존', authority_policy: {}, tool_policy: {} };
    queryOne.mockResolvedValueOnce(row);
    isProjectOwner.mockResolvedValue(true);
    ensureProjectAgentInstruction.mockImplementationOnce(() => { throw new Error('AGENTS.md not found'); });
    const [, update]: any = createPrimaryAgentProfileTools({ userId: 1, userRole: 'member', projectId: 'talent' });
    const out = await update.execute('update', { targetProjectId: 'p1', confirmed: true, expectedVersion: 1, changes: { role: '새 역할' } });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('could not be synchronized');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('profile tool reserved execution authority', () => {
  it.each(['member', 'operator', 'admin'])('rejects absent-key insertion in preview and apply for %s', async userRole => {
    queryOne.mockReset().mockResolvedValue({ root_path: '/workspace/project', instruction_version: 3, authority_policy: {}, tool_policy: {} });
    const [preview, update]: any = createPrimaryAgentProfileTools({ userId: 1, userRole, projectId: 'p1' });
    const request = { targetProjectId: 'p1', confirmed: true, expectedVersion: 3, changes: { authorityPolicy: { superuser: true } } };
    for (const tool of [preview, update]) {
      const response = await tool.execute('reserved', request);
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('AGENT_EXECUTION_AUTHORITY_RESERVED');
    }
    expect(ensureProjectAgentInstruction).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('shows the same preserved platform key in preview as is written by apply', async () => {
    queryOne.mockReset().mockResolvedValue({ root_path: '/workspace/project', instruction_version: 3, authority_policy: { superuser: true }, tool_policy: {} });
    execute.mockResolvedValue({ changes: 1 });
    const [preview, update]: any = createPrimaryAgentProfileTools({ userId: 1, userRole: 'member', projectId: 'p1' });
    const request = { targetProjectId: 'p1', confirmed: true, expectedVersion: 3, changes: { authorityPolicy: { externalActions: 'confirm' } } };
    const shown = JSON.parse((await preview.execute('preview', request)).content[0].text);
    expect(shown.after.authorityPolicy).toEqual({ superuser: true, externalActions: 'confirm' });
    await update.execute('apply', request);
    expect(JSON.parse(execute.mock.calls[0][1][6])).toEqual(shown.after.authorityPolicy);
  });
});
