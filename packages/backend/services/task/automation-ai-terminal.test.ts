import { installModelRegistryFixture } from '../../__tests__/fixtures/model-registry.js';
import { beforeEach as beforeRegistryTest, afterEach as afterRegistryTest } from 'vitest';
beforeRegistryTest(() => { installModelRegistryFixture(); });
afterRegistryTest(() => vi.restoreAllMocks());
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./task-manager.js', () => ({ createTask: vi.fn(async () => ({ id: 'task-1' })), getTask: vi.fn() }));
vi.mock('../pm/project-manager.js', () => ({ getProject: vi.fn(async () => ({ rootPath: '/workspace', archived: false, lifecycleStatus: 'active' })) }));
vi.mock('./task-runner.js', () => ({ spawnTask: vi.fn(async () => undefined) }));
import { createTask, getTask } from './task-manager.js';
import { spawnTask } from './task-runner.js';
import { runAutomationJob } from './automation-runners.js';
import { getProject } from '../pm/project-manager.js';
import { getModelDefaults } from '../../config.js';
import type { Automation } from './automation-manager.js';
const automation = { id: 'a1', userId: 1, name: 'briefing', jobType: 'ai_prompt', mode: 'spawn', prompt: 'brief', model: 'test', cwd: '/workspace', definitionJson: {} } as Automation;
beforeEach(() => vi.clearAllMocks());
describe('AI terminal outcome', () => {
  it('rejects an unavailable project without creating a task', async () => {
    vi.mocked(getProject).mockResolvedValueOnce(null);
    await expect(runAutomationJob({ ...automation, projectId: 'project-1', scopeType: 'project' }, vi.fn()))
      .rejects.toThrow('refusing to substitute');
    expect(createTask).not.toHaveBeenCalled();
  });
  it('rejects a retired project without substituting its old cwd', async () => {
    vi.mocked(getProject).mockResolvedValueOnce({ rootPath: '/workspace', archived: false, lifecycleStatus: 'retired' } as any);
    await expect(runAutomationJob({ ...automation, projectId: 'project-1', scopeType: 'project' }, vi.fn()))
      .rejects.toThrow('refusing to substitute');
    expect(createTask).not.toHaveBeenCalled();
  });
  it('rejects a cwd outside the selected project', async () => {
    await expect(runAutomationJob({ ...automation, projectId: 'project-1', scopeType: 'project', cwd: '/other-project' }, vi.fn()))
      .rejects.toThrow('cwd escapes project scope');
    expect(createTask).not.toHaveBeenCalled();
    expect(spawnTask).not.toHaveBeenCalled();
  });
  it.each(['done', 'failed', 'todo'] as const)('reports persisted %s after engine termination', async status => {
    vi.mocked(getTask).mockResolvedValueOnce({ status, sessionId: 'session-1', progressSummary: ['result'] } as any);
    const result = await runAutomationJob(automation, vi.fn());
    expect(result.status).toBe(status === 'done' ? 'success' : 'failed');
    expect(result.runnerRef).toBe('completed-session:session-1');
    expect(createTask).toHaveBeenCalled();
    expect(spawnTask).toHaveBeenCalledWith('task-1', expect.any(Function), 1, undefined, undefined, { waitForCompletion: true });
  });
  it('passes a stored system-project sentinel to the Task boundary for normalization', async () => {
    vi.mocked(getTask).mockResolvedValueOnce({ status: 'done', sessionId: 'session-1' } as any);
    await runAutomationJob({
      ...automation,
      projectId: '00000000-0000-0000-0000-000000000000',
      scopeType: 'system',
    } as Automation, vi.fn());

    expect(createTask).toHaveBeenCalledWith(
      'briefing',
      'brief',
      '/workspace',
      1,
      'test',
      undefined,
      'default',
      undefined,
      '00000000-0000-0000-0000-000000000000',
      undefined,
      'silent',
    );
  });

  it('preserves the real project id for project-scoped execution tasks', async () => {
    vi.mocked(getTask).mockResolvedValueOnce({ status: 'done', sessionId: 'session-1' } as any);
    await runAutomationJob({
      ...automation,
      projectId: 'project-1',
      scopeType: 'project',
    } as Automation, vi.fn());

    expect(createTask).toHaveBeenCalledWith(
      'briefing',
      'brief',
      '/workspace',
      1,
      'test',
      undefined,
      'default',
      undefined,
      'project-1',
      undefined,
      'silent',
    );
  });

  it('skips concurrent execution while the first runner is awaited', async () => {
    let release!: () => void;
    vi.mocked(spawnTask).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    vi.mocked(getTask).mockResolvedValueOnce({ status: 'done', sessionId: 'session-1' } as any);
    const first = runAutomationJob(automation, vi.fn());
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect((await runAutomationJob(automation, vi.fn())).status).toBe('skipped');
    release();
    expect((await first).status).toBe('success');
  });
});

describe('Core preset execution', () => {
  it('resolves the current admin mapping when a schedule runs, without changing the saved choice', async () => {
    vi.mocked(getTask).mockResolvedValueOnce({ status: 'done' } as any);
    await runAutomationJob({ ...automation, model: 'preset/core' }, vi.fn());
    expect(vi.mocked(createTask).mock.calls[0]?.[4]).toBe(getModelDefaults().session);
  });
});
