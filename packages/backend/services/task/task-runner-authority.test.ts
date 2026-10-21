import { beforeEach, describe, expect, it, vi } from 'vitest';

let task: any;
const runCalls: any[] = [];
const updateTaskCalls: any[] = [];
const buildSystemPromptCalls: any[] = [];
const markAgentTurnCheckpoint = vi.fn(async () => undefined);
let engineMessages: any[] = [];
let engineGate: Promise<void> | undefined;
let sessionRow: any;
let resumeEngineSessionId: string | undefined;
const createSessionMock = vi.fn(async (_name: string, cwd: string, userId?: number, projectId?: string | null) => ({
  id: 'session-1',
  shortCode: 'short1',
  name: '[task] test',
  cwd,
  tags: [],
  favorite: false,
  totalCost: 0,
  totalTokens: 0,
  createdAt: '2026-07-03T00:00:00.000Z',
  updatedAt: '2026-07-03T00:00:00.000Z',
  projectId: projectId || null,
  engine: 'pi',
  roomId: null,
  parentSessionId: null,
  sourceMessageId: null,
  ownerUsername: 'admin',
  visibility: 'private',
  label: null,
  configDir: null,
  modelUsed: 'litellm-responses/mini',
}));

vi.mock('./task-manager.js', () => ({
  getTask: vi.fn(async () => task),
  updateTask: vi.fn(async (_id: string, updates: any) => {
    updateTaskCalls.push(updates);
    task = { ...task, ...updates };
    return task;
  }),
  getTasks: vi.fn(async () => []),
}));

vi.mock('../session/session-manager.js', () => ({
  createSession: (...args: any[]) => createSessionMock(...args as Parameters<typeof createSessionMock>),
  getSession: vi.fn(async () => sessionRow),
  getEngineSessionId: vi.fn(() => resumeEngineSessionId),
  claimEngineSessionId: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../message-store.js', () => ({
  saveMessage: vi.fn(),
  attachToolResultInDb: vi.fn(),
  updateMessageContent: vi.fn(),
  updateMessageMetrics: vi.fn(),
  markAgentTurnCheckpoint,
}));

vi.mock('../auth/auth.js', () => ({
  getUserRole: vi.fn(async (userId: number) => userId === 1 ? 'admin' : 'member'),
  getUserAllowedPath: vi.fn(async () => '/workspace/projects'),
}));

vi.mock('../pm/project-access.js', () => ({
  getUserAccessiblePaths: vi.fn(async (_userId: number, role: string) => role === 'admin' ? null : ['/home/tower/workspace/projects/demo']),
  buildToolGuard: vi.fn(() => () => ({ allowed: true })),
  resolveSessionProjectRoot: vi.fn(() => '/home/tower/tower'),
  findProjectByPath: vi.fn(async () => 'tower-project'),
}));

vi.mock('../../db/pg-repo.js', () => ({
  queryOne: vi.fn(async () => null),
}));

vi.mock('../system-prompt.js', () => ({
  buildSystemPrompt: vi.fn(async (input: any) => {
    buildSystemPromptCalls.push(input);
    return 'system prompt';
  }),
}));

vi.mock('../../engines/index.js', () => ({
  getEngine: vi.fn(async () => ({
    run: async function* (_sessionId: string, _prompt: string, opts: any) {
      runCalls.push({ ...opts, prompt: _prompt });
      await engineGate;
      for (const message of engineMessages) {
        yield message;
      }
      yield { type: 'engine_done', sessionId: 'session-1', engineSessionId: 'engine-1' };
    },
  })),
}));

vi.mock('../workflow-prompts.js', () => ({
  buildUnattendedPrompt: vi.fn(() => 'Do the task'),
}));

vi.mock('../git/worktree-manager.js', () => ({
  createWorktree: vi.fn(() => null),
}));

vi.mock('../workspace/jsonl-utils.js', () => ({
  buildJsonlPath: vi.fn(() => '/tmp/nope.jsonl'),
  checkJsonlForCompletion: vi.fn(() => ({ status: 'running', stages: [] })),
}));

function finalStatusUpdates() {
  return updateTaskCalls.filter((updates) => updates.completedAt && updates.status);
}

describe('task-runner authority context', () => {
  beforeEach(() => {
    runCalls.length = 0;
    updateTaskCalls.length = 0;
    buildSystemPromptCalls.length = 0;
    markAgentTurnCheckpoint.mockClear();
    engineMessages = [];
    engineGate = undefined;
    resumeEngineSessionId = undefined;
    createSessionMock.mockClear();
    sessionRow = { id: 'session-1', configDir: null, engineSessionId: null, claudeSessionId: null, engine: 'pi' };
    task = {
      id: 'task-1',
      title: 'Patch Tower',
      description: 'Modify the Tower repo',
      cwd: '/home/tower/tower',
      engine: 'pi',
      model: 'litellm-responses/mini',
      status: 'todo',
      sessionId: null,
      sortOrder: 0,
      progressSummary: [],
      todoSnapshot: null,
      createdAt: '2026-07-03T00:00:00.000Z',
      updatedAt: '2026-07-03T00:00:00.000Z',
      completedAt: null,
      userId: 1,
      creatorName: 'admin',
      scheduledAt: null,
      scheduleCron: null,
      scheduleEnabled: false,
      workflow: 'default',
      parentTaskId: null,
      worktreePath: null,
      projectId: 'tower-project',
      roomId: null,
      triggeredBy: null,
      roomMessageId: null,
      reportPolicy: 'silent',
    };
  });

  it('passes request-selected guidance to both the shared prompt and engine without developer-only rules', async () => {
    task.title = '고객 보고서 PDF';
    task.description = 'PDF 보고서를 만들어줘';
    const { selectSystemPromptFragmentsForMessage } = await import('../system-prompt-fragments.js');
    const { spawnTask } = await import('./task-runner.js');
    await spawnTask('task-1', () => {}, 1, undefined, undefined, { waitForCompletion: true });
    const expected = selectSystemPromptFragmentsForMessage(`${task.title}\n${task.description}`);
    expect(expected.length).toBeGreaterThan(0);
    expect(buildSystemPromptCalls[0].optionalFragments).toEqual(expected);
    expect(runCalls[0].systemPromptFragments).toEqual(expected);
    expect(runCalls[0].prompt).not.toContain('## 3. Git commit');
    expect(runCalls[0].prompt).not.toContain('Architecture pre-check');
    expect(runCalls[0].prompt).not.toContain('Do not ask questions');
    expect(runCalls[0].prompt).toContain('Unattended execution does not grant additional authority');
  });

  it('passes the run-as username and path scope to the engine', async () => {
    const { queryOne } = await import('../../db/pg-repo.js');
    vi.mocked(queryOne).mockImplementation(async (sql: string) =>
      sql.includes('SELECT username') ? { username: 'scheduled-user' } as any : null);
    try {
      const { spawnTask } = await import('./task-runner.js');
      await spawnTask('task-1', () => {}, 1, 'admin', '/workspace', { waitForCompletion: true });
      expect(runCalls[0]).toMatchObject({ username: 'scheduled-user', allowedPath: '/workspace' });
      expect(buildSystemPromptCalls[0]).toMatchObject({ username: 'scheduled-user' });
    } finally {
      vi.mocked(queryOne).mockImplementation(async () => null);
    }
  });

  it.each([true, false])('waitForCompletion=%s preserves the requested completion boundary', async waitForCompletion => {
    let release!: () => void;
    engineGate = new Promise<void>(resolve => { release = resolve; });
    engineMessages = [{ type: 'assistant', content: [{ type: 'text', text: '[TASK COMPLETE]' }] }];
    const { spawnTask } = await import('./task-runner.js');
    let settled = false;
    const pending = spawnTask('task-1', () => {}, 1, undefined, undefined, { waitForCompletion })
      .then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(runCalls.length).toBe(1));
      expect(task.status).toBe('in_progress');
      expect(settled).toBe(!waitForCompletion);
    } finally {
      release();
      await pending;
      await vi.waitFor(() => expect(task.status).toBe('done'));
    }
  });

  it('derives scheduled task role from persisted run-as user when caller omitted userRole', async () => {
    const { spawnTask } = await import('./task-runner.js');
    await spawnTask('task-1', () => {}, 1);
    await vi.waitFor(() => expect(runCalls.length).toBe(1));

    expect(buildSystemPromptCalls[0]).toMatchObject({ username: 'task-agent', role: 'admin' });
    expect(runCalls[0]).toMatchObject({ userId: 1, userRole: 'admin', accessiblePaths: null, allowedPath: '/workspace/projects' });
  });

  it('registers the Pi task root turn before engine.run claims it', async () => {
    const { spawnTask } = await import('./task-runner.js');
    await spawnTask('task-1', () => {}, 1);
    await vi.waitFor(() => expect(runCalls.length).toBe(1));

    expect(markAgentTurnCheckpoint).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      status: 'started',
      sessionId: 'session-1',
      engine: 'pi',
      model: 'litellm-responses/mini',
    }));
    expect(runCalls[0].rootTurnId).toEqual(markAgentTurnCheckpoint.mock.calls[0][0]);
  });

  it('reuses the same Tower Session when retrying a failed Pi task with native resume state', async () => {
    task.status = 'failed';
    task.sessionId = 'failed-session';
    resumeEngineSessionId = '/workspace/project/.pi/sessions/failed.jsonl';
    sessionRow = {
      ...await createSessionMock('[task] test', task.cwd, 1, task.projectId),
      id: 'failed-session',
      engineSessionId: resumeEngineSessionId,
      piSessionFile: resumeEngineSessionId,
    };
    createSessionMock.mockClear();

    const { spawnTask } = await import('./task-runner.js');
    await spawnTask('task-1', () => {}, 1);
    await vi.waitFor(() => expect(runCalls.length).toBe(1));

    expect(createSessionMock).not.toHaveBeenCalled();
    expect(updateTaskCalls).toContainEqual(expect.objectContaining({
      status: 'in_progress',
      sessionId: 'failed-session',
    }));
    expect(runCalls[0]).toMatchObject({ engineSessionId: resumeEngineSessionId });
  });

  it('accepts an explicit no-work marker as a normal completed check', async () => {
    engineMessages = [{ type: 'assistant', sessionId: 'session-1', content: [{ type: 'text', text: '[TASK NONE]' }] }];
    const { spawnTask } = await import('./task-runner.js');
    await spawnTask('task-1', () => {}, 1);
    await vi.waitFor(() => expect(finalStatusUpdates().at(-1)?.status).toBe('done'));
    expect(finalStatusUpdates().at(-1)?.progressSummary).toContain('[TASK NONE]');
  });

  it('marks localized TASK FAILED markers as failed instead of done', async () => {
    engineMessages = [{
      type: 'assistant',
      sessionId: 'session-1',
      content: [{
        type: 'text',
        text: '[STAGE: Research]\n[TASK FAILED: 도구 실행 없이 원격 조회를 수행할 수 없습니다.]',
      }],
    }];

    const { spawnTask } = await import('./task-runner.js');
    await spawnTask('task-1', () => {}, 1);

    await vi.waitFor(() => expect(finalStatusUpdates().at(-1)?.status).toBe('failed'));
    expect(finalStatusUpdates().at(-1)?.progressSummary).toContain('도구 실행 없이 원격 조회를 수행할 수 없습니다.');
  });

  it('marks engine runs without a task terminal marker as failed', async () => {
    engineMessages = [{
      type: 'assistant',
      sessionId: 'session-1',
      content: [{
        type: 'commentary',
        visibility: 'progress',
        text: '먼저 구조를 확인하겠습니다.',
      }],
    }];

    const { spawnTask } = await import('./task-runner.js');
    await spawnTask('task-1', () => {}, 1);

    await vi.waitFor(() => expect(finalStatusUpdates().at(-1)?.status).toBe('failed'));
    expect(finalStatusUpdates().at(-1)?.progressSummary.join('\n')).toContain('Task ended without required [TASK COMPLETE] or [TASK FAILED] marker');
  });

  it('detects task stage and completion markers in visible commentary blocks', async () => {
    engineMessages = [{
      type: 'assistant',
      sessionId: 'session-1',
      content: [{
        type: 'commentary',
        visibility: 'progress',
        text: '[STAGE: Research]\n[TASK COMPLETE]\n확인 완료',
      }],
    }];

    const { spawnTask } = await import('./task-runner.js');
    await spawnTask('task-1', () => {}, 1);

    await vi.waitFor(() => expect(finalStatusUpdates().at(-1)?.status).toBe('done'));
    expect(finalStatusUpdates().at(-1)?.progressSummary).toContain('Research');
  });

  it('marks engine_error messages as failed', async () => {
    engineMessages = [{
      type: 'engine_error',
      sessionId: 'session-1',
      message: 'Pi session creation failed: provider error',
    }];

    const { spawnTask } = await import('./task-runner.js');
    await spawnTask('task-1', () => {}, 1);

    await vi.waitFor(() => expect(finalStatusUpdates().at(-1)?.status).toBe('failed'));
    expect(finalStatusUpdates().at(-1)?.progressSummary).toContain('Pi session creation failed: provider error');
  });
});
