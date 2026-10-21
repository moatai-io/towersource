import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ create: vi.fn(), policy: vi.fn(), project: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ transaction: vi.fn() }));
vi.mock('../pm/project-manager.js', () => ({ getProject: state.project }));
vi.mock('../pm/project-access.js', () => ({ canAccessSession: vi.fn() }));
vi.mock('../session/session-manager.js', () => ({ getSession: vi.fn() }));
vi.mock('../../config.js', () => ({ isSelectablePiModelId: vi.fn(() => true) }));
vi.mock('../model-policy/session-alias.js', () => ({ persistPiSessionChoice: (value: string) => value }));
vi.mock('./automation-model.js', () => ({ resolveAutomationModel: (value: string) => value }));
vi.mock('./automation-mutation-policy.js', () => ({ authorizeAutomationMutation: state.policy }));
vi.mock('./automation-creation-readiness.js', () => ({ inspectAutomationCreationReadiness: vi.fn(async () => ({ agentExecutionAccess: 'allowed', workspacePath: 'accessible' })) }));
vi.mock('./schedule-permissions.js', () => ({ canAccessAutomationJob: vi.fn() }));
vi.mock('./automation-manager.js', () => ({ createAutomation: state.create, getAutomationForUpdateInTransaction: vi.fn(), activateCreationPlanInTransaction: vi.fn() }));
import { compileCreationTrigger, previewAutomationCreation } from './automation-create-plan.js';

const actor = { userId: 7, role: 'member' };
const now = new Date('2026-09-28T00:00:00Z');
beforeEach(() => {
  vi.clearAllMocks();
  state.policy.mockResolvedValue({ allowed: true });
  state.project.mockResolvedValue({ name: 'Test', archived: false, lifecycleStatus: 'active', rootPath: '/project' });
  state.create.mockImplementation(async (data: any) => ({ ...data, id: 'draft', cwd: '/project', status: 'idle', targetId: null, timeoutSeconds: null, riskLevel: 'low', cronConfig: data.cronConfig ?? null, onceAt: data.onceAt ?? null }));
});

describe('independent creation-plan ambiguity regression', () => {
  it('does not silently select the first of two requested clock times', () => {
    expect(compileCreationTrigger('매일 오전 9시와 오후 6시에 보고해줘')).toBeNull();
  });
  it('does not let an explicit trigger override conflicting natural-language timing', async () => {
    const plan = await previewAutomationCreation({ projectId: 'p1', request: '매일 오전 9시에 보고해줘', trigger: { type: 'manual' } }, actor, now);
    expect(plan.kind).toBe('clarification');
    expect(state.create).not.toHaveBeenCalled();
  });
  it('does not let an explicit trigger turn an invalid clock time into a saved plan', async () => {
    const plan = await previewAutomationCreation({ projectId: 'p1', request: '매일 25시에 보고해줘', trigger: { type: 'cron', config: { type: 'daily', hour: 9, minute: 0 } } }, actor, now);
    expect(plan.kind).toBe('clarification');
    expect(state.create).not.toHaveBeenCalled();
  });
  it('does not promise unsupported price-conditional execution with an explicit cron trigger', async () => {
    const plan = await previewAutomationCreation({ projectId: 'p1', request: '매일 9시에 BTC 가격이 10만 달러 넘으면 그때만 알림 보내줘', trigger: { type: 'cron', config: { type: 'daily', hour: 9, minute: 0 } } }, actor, now);
    expect(plan.kind).toBe('unsupported');
    expect(state.create).not.toHaveBeenCalled();
  });
  it.each(['매일 오전 9시에 이메일로 결과를 보내줘', '매일 오전 9시에 요약하고 오류가 있으면 이메일로 보내줘'])('does not promise unsupported mail delivery: %s', async request => {
    expect(await previewAutomationCreation({ projectId: 'p1', request }, actor, now)).toMatchObject({ kind: 'unsupported' });
    expect(state.create).not.toHaveBeenCalled();
  });
  it('does not store a draft for unsupported webhook even if an explicit trigger is supplied', async () => {
    expect(await previewAutomationCreation({ projectId: 'p1', request: '매일 9시 webhook으로 실행해줘', trigger: { type: 'manual' } }, actor, now)).toMatchObject({ kind: 'unsupported' });
    expect(state.create).not.toHaveBeenCalled();
  });
});
