import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ draft: null as any }));
vi.mock('../../db/pg-repo.js', () => ({ transaction: async (fn: any) => fn({}) }));
vi.mock('../pm/project-manager.js', () => ({ getProject: vi.fn(async () => ({ name: 'Test Agent', rootPath: '/project', lifecycleStatus: 'active', archived: false })) }));
vi.mock('../pm/project-access.js', () => ({ canAccessSession: vi.fn(async () => ({ allowed: true })) }));
vi.mock('../session/session-manager.js', () => ({ getSession: vi.fn(async () => ({ projectId: 'p1', engine: 'pi', modelUsed: 'openrouter/test-model' })) }));
vi.mock('../../config.js', () => ({ isSelectablePiModelId: vi.fn(() => true) }));
vi.mock('../model-policy/session-alias.js', () => ({ persistPiSessionChoice: (x: string) => x }));
vi.mock('./automation-model.js', () => ({ resolveAutomationModel: (x: string) => x === 'preset/core' ? 'litellm-responses/core' : x }));
vi.mock('./automation-creation-readiness.js', () => ({ inspectAutomationCreationReadiness: vi.fn(async () => ({ agentExecutionAccess: 'allowed', workspacePath: 'accessible' })) }));
vi.mock('./schedule-permissions.js', () => ({ canAccessAutomationJob: vi.fn(async () => ({ allowed: true })) }));
vi.mock('./automation-mutation-policy.js', () => ({ authorizeAutomationMutation: vi.fn(async () => ({ allowed: true })) }));
vi.mock('./automation-manager.js', () => ({
  createAutomation: vi.fn(async (data: any) => state.draft = { ...data, id: 'a1', cwd: '/project', status: 'idle', targetId: null, timeoutSeconds: null, riskLevel: 'low', cronConfig: data.cronConfig || null, onceAt: data.onceAt || null }),
  getAutomationForUpdateInTransaction: vi.fn(async () => state.draft),
  activateCreationPlanInTransaction: vi.fn(async (_c: any, _id: string, update: any) => state.draft = { ...state.draft, ...update }),
}));
import { activateAutomationCreation, compileCreationTrigger, creationPlanHash, previewAutomationCreation } from './automation-create-plan.js';
import { createAutomation, activateCreationPlanInTransaction } from './automation-manager.js';
import { authorizeAutomationMutation } from './automation-mutation-policy.js';
import { getSession } from '../session/session-manager.js';
import { isSelectablePiModelId } from '../../config.js';
import { inspectAutomationCreationReadiness } from './automation-creation-readiness.js';
const actor = { userId: 7, role: 'member' };
const now = new Date('2026-09-28T00:00:00Z');
const raw = { request: '매일 오전 9시에 업무 요약을 해줘', projectId: 'p1' };
beforeEach(() => { vi.clearAllMocks(); state.draft = null; });
describe('creation plan bounded compiler', () => {
  it.each([
    ['매일 오전 9시에 요약', { type: 'cron', config: { type: 'daily', hour: 9, minute: 0 } }],
    ['평일 오후 2시 30분 요약', { type: 'cron', config: { type: 'weekdays', hour: 14, minute: 30 } }],
    ['매주 월요일 9시에 요약', { type: 'cron', config: { type: 'weekly', day: 1, hour: 9, minute: 0 } }],
    ['30분마다 요약', { type: 'cron', config: { type: 'interval', minutes: 30 } }],
    ['필요할 때 요약', { type: 'manual' }],
    ['아침에 요약', null], ['매일 평일 오전 9시에', null], ['매일 25시에', null], ['매주 오전 9시', null],
  ])('%s', (text, expected) => expect(compileCreationTrigger(text)).toEqual(expected));
  it('preserves supported single-day weekly requests', () => {
    for (const request of ['매주 월 오전 9시에 요약', '매주 월요일 오전 9시에 요약', 'weekly Monday 09:00 summarize']) {
      expect(compileCreationTrigger(request)).toEqual({ type: 'cron', config: { type: 'weekly', day: 1, hour: 9, minute: 0 } });
    }
  });
  it('requires clarification rather than choosing the first of multiple weekly days', () => {
    expect(compileCreationTrigger('매주 월요일과 화요일 오전 9시에 요약')).toBeNull();
    expect(compileCreationTrigger('weekly Monday and Tuesday 09:00 summarize')).toBeNull();
  });
  it('fails closed on an interval combined with a daily clock time', () => {
    expect(compileCreationTrigger('매일 9시에 10분마다 요약해줘')).toBeNull();
  });
});
describe('server reviewed creation and activation', () => {
  it('creates disabled draft only; no AI; activation reuses id and replay writes nothing', async () => {
    const plan = await previewAutomationCreation(raw, actor, now);
    expect(plan.kind).toBe('plan'); if (plan.kind !== 'plan') throw Error();
    expect(plan.automation.enabled).toBe(false);
    expect(plan.automation.workflow).toBe('default');
    expect(plan.automation.model).toBe('preset/core');
    expect(plan.nextRunTimes).toHaveLength(3);
    expect(plan.nextRunTimes[0]).toBe(plan.nextRunAt);
    expect(plan.readiness).toMatchObject({ workspace: 'active', createPermission: 'allowed', modelSelection: 'selectable', agentExecutionAccess: 'allowed', workspacePath: 'accessible', executionAndProvider: 'not_verified', dataAndWriteScope: 'not_verified' });
    expect(createAutomation).toHaveBeenCalledTimes(1);
    const activated = await activateAutomationCreation('a1', plan.proposalHash, actor, true, now);
    expect(activated.automation?.id).toBe(plan.automation.id);
    expect(activated.automation?.enabled).toBe(true);
    expect(await activateAutomationCreation('a1', plan.proposalHash, actor, true, now)).toMatchObject({ replayed: true });
    expect(activateCreationPlanInTransaction).toHaveBeenCalledTimes(1);
  });
  it('asks ambiguous timing without storing or inventing an interval', async () => {
    expect(await previewAutomationCreation({ ...raw, request: '업무 요약해줘' }, actor, now)).toMatchObject({ kind: 'clarification' });
    expect(createAutomation).not.toHaveBeenCalled();
  });
  it.each([
    '매일 9시 오류가 있을 때만 실행해',
    '매일 오전 9시에 요약하고 오류가 있으면 이메일로 보내줘',
    '매일 오전 9시에 이메일로 결과를 보내줘',
  ])('blocks conditional or outbound email promises before storing: %s', async request => {
    expect(await previewAutomationCreation({ ...raw, request }, actor, now)).toMatchObject({ kind: 'unsupported' });
    expect(createAutomation).not.toHaveBeenCalled();
  });
  it('does not discard a conflicting explicit time selection', async () => {
    expect(await previewAutomationCreation({ ...raw, trigger: { type: 'manual' } }, actor, now)).toMatchObject({ kind: 'clarification' });
    expect(createAutomation).not.toHaveBeenCalled();
  });
  it('allows explicit trigger clarification', async () => {
    expect(await previewAutomationCreation({ ...raw, request: '요약', trigger: { type: 'manual' } }, actor, now)).toMatchObject({ kind: 'plan', nextRunAt: null });
  });
  it('inherits only an accessible same-project Pi session selection', async () => {
    const plan = await previewAutomationCreation({ ...raw, modelMode: 'session', sourceSessionId: 's1' }, actor, now);
    expect(plan).toMatchObject({ kind: 'plan', automation: { model: 'openrouter/test-model' } });
    vi.mocked(getSession).mockResolvedValueOnce({ projectId: 'other', engine: 'pi', modelUsed: 'openrouter/test-model' } as any);
    await expect(previewAutomationCreation({ ...raw, modelMode: 'session', sourceSessionId: 's1' }, actor, now)).rejects.toThrow('Workspace');
  });
  it('rejects invalid unknown fields, timezone, dates, and unavailable model', async () => {
    await expect(previewAutomationCreation({ ...raw, enabled: true }, actor, now)).rejects.toThrow();
    await expect(previewAutomationCreation({ ...raw, timezone: 'Not/AZone' }, actor, now)).rejects.toThrow('시간대');
    await expect(previewAutomationCreation({ ...raw, request: '요약해줘', trigger: { type: 'once', at: '2026-09-27T01:00:00Z' } }, actor, now)).rejects.toThrow('미래');
    vi.mocked(isSelectablePiModelId).mockReturnValueOnce(false);
    await expect(previewAutomationCreation(raw, actor, now)).rejects.toThrow('모델');
  });
  it('previews three weekday occurrences using the configured timezone across a DST change', async () => {
    const plan = await previewAutomationCreation({ request: '평일 오전 9시에 요약', projectId: 'p1', timezone: 'America/New_York' }, actor, new Date('2026-03-06T15:00:00Z'));
    if (plan.kind !== 'plan') throw Error();
    expect(plan.nextRunTimes).toEqual(['2026-03-09T13:00:00.000Z', '2026-03-10T13:00:00.000Z', '2026-03-11T13:00:00.000Z']);
  });
  it('shows no future occurrence for manual and only one for a one-time trigger', async () => {
    const manual = await previewAutomationCreation({ ...raw, request: '필요할 때 요약' }, actor, now);
    if (manual.kind !== 'plan') throw Error();
    expect(manual.nextRunTimes).toEqual([]);
    expect(manual.nextRunAt).toBeNull();
    const once = await previewAutomationCreation({ ...raw, request: '요약', trigger: { type: 'once', at: '2026-09-28T00:05:00Z' } }, actor, now);
    if (once.kind !== 'plan') throw Error();
    expect(once.nextRunTimes).toEqual(['2026-09-28T00:05:00Z']);
  });
  it('rejects a one-time draft whose scheduled time passed during review', async () => {
    const plan = await previewAutomationCreation({ ...raw, request: '요약', trigger: { type: 'once', at: '2026-09-28T00:05:00Z' } }, actor, now);
    if (plan.kind !== 'plan') throw Error();
    await expect(activateAutomationCreation('a1', plan.proposalHash, actor, true, new Date('2026-09-28T00:06:00Z'))).rejects.toThrow('예정 시각');
    expect(activateCreationPlanInTransaction).not.toHaveBeenCalled();
  });
  it('does not create a draft when current execution authority or workspace is unavailable', async () => {
    vi.mocked(inspectAutomationCreationReadiness).mockRejectedValueOnce(new Error('private path not readable'));
    await expect(previewAutomationCreation(raw, actor, now)).rejects.toThrow('Agent 실행 권한 또는 Workspace');
    expect(createAutomation).not.toHaveBeenCalled();
  });
  it('rechecks execution readiness before activation without activating an unavailable draft', async () => {
    const plan = await previewAutomationCreation(raw, actor, now);
    if (plan.kind !== 'plan') throw Error();
    vi.mocked(inspectAutomationCreationReadiness).mockRejectedValueOnce(new Error('AGENT_EXECUTION_ACCESS_DENIED'));
    await expect(activateAutomationCreation('a1', plan.proposalHash, actor, true, now)).rejects.toThrow('Agent 실행 권한 또는 Workspace');
    expect(activateCreationPlanInTransaction).not.toHaveBeenCalled();
  });
  it('rechecks authorization; no draft on denial', async () => {
    vi.mocked(authorizeAutomationMutation).mockResolvedValueOnce({ allowed: false, status: 403, message: 'forbidden' });
    await expect(previewAutomationCreation(raw, actor, now)).rejects.toThrow('forbidden');
    expect(createAutomation).not.toHaveBeenCalled();
  });
  it('rejects missing confirmation, changed plan hash, changed creator, and expiry without activating', async () => {
    const plan = await previewAutomationCreation(raw, actor, now); if (plan.kind !== 'plan') throw Error();
    await expect(activateAutomationCreation('a1', plan.proposalHash, actor, false, now)).rejects.toThrow('확인');
    await expect(activateAutomationCreation('a1', plan.proposalHash, { userId: 8, role: 'admin' }, true, now)).rejects.toThrow('작성자');
    await expect(activateAutomationCreation('a1', plan.proposalHash, actor, true, new Date('2026-09-28T00:16:00Z'))).rejects.toThrow('만료');
    state.draft.prompt = 'changed';
    expect(creationPlanHash(state.draft)).not.toBe(plan.proposalHash);
    await expect(activateAutomationCreation('a1', plan.proposalHash, actor, true, now)).rejects.toThrow('변경');
    expect(activateCreationPlanInTransaction).not.toHaveBeenCalled();
  });
});
