import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, getAccessibleProjectIdsMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  getAccessibleProjectIdsMock: vi.fn(),
}));

vi.mock('../../db/pg-repo.js', () => ({
  query: queryMock,
}));

vi.mock('../pm/project-membership-manager.js', () => ({
  getAccessibleProjectIds: getAccessibleProjectIdsMock,
}));

import { getChallengeTimeline } from './challenge-timeline.js';

function assistantContent(input: any): string {
  return JSON.stringify([
    {
      type: 'tool_use',
      name: 'TodoWrite',
      input,
    },
  ]);
}

describe('getChallengeTimeline TodoWrite metadata compatibility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T06:00:00.000Z'));
    queryMock.mockReset();
    getAccessibleProjectIdsMock.mockReset();
  });

  afterAll(() => vi.useRealTimers());

  it('groups v3 TodoWrite snapshots by workstreamKey and preserves backlog/questions metadata', async () => {
    queryMock.mockResolvedValueOnce([]);
    queryMock.mockResolvedValueOnce([
      {
        session_id: 's-1',
        session_name: 'Run A',
        project_id: 'p-1',
        project_name: 'Tower',
        owner_user_id: 1,
        owner_name: 'Admin',
        created_at: new Date('2026-06-28T00:00:00.000Z'),
        content: assistantContent({
          work: {
            mode: 'new',
            workstreamKey: 'todowrite-v3',
            workstreamTitle: 'TodoWrite Ledger v3',
            runTitle: 'Parser pass',
            outcome: 'Grouped by workstream',
          },
          todos: [{ content: 'Implement parser', status: 'completed', activeForm: 'Implementing parser' }],
          backlog: [{ type: 'docs', title: 'Document detail view', priority: 'P2', reason: 'Future UI' }],
          questions: [{ title: 'Should backlog render in detail panel?', status: 'open', reason: 'Avoid timeline clutter' }],
        }),
      },
      {
        session_id: 's-2',
        session_name: 'Run B',
        project_id: 'p-1',
        project_name: 'Tower',
        owner_user_id: 1,
        owner_name: 'Admin',
        created_at: new Date('2026-06-28T01:00:00.000Z'),
        content: assistantContent({
          work: {
            mode: 'continue',
            workstreamKey: 'todowrite-v3',
            workstreamTitle: 'TodoWrite Ledger v3',
            runTitle: 'Schema pass',
          },
          todos: [{ content: 'Update schema', status: 'in_progress', activeForm: 'Updating schema' }],
        }),
      },
    ]);

    const result = await getChallengeTimeline({ userId: 1, role: 'admin', rangeHours: 24, bucketHours: 1 });

    expect(result.totals.challenges).toBe(1);
    expect(queryMock.mock.calls[1]?.[1]).toContain(1);
    const row = result.projects[0]?.challenges[0];
    expect(row).toMatchObject({
      title: 'TodoWrite Ledger v3',
      workstreamKey: 'todowrite-v3',
      sessionCount: 2,
      todoTotal: 2,
      todoDone: 1,
      todoLeft: 1,
      status: 'active',
    });
    expect(row?.runTitles).toEqual(['Parser pass', 'Schema pass']);
    expect(row?.outcomes).toEqual(['Grouped by workstream']);
    expect(row?.sessions).toEqual([
      expect.objectContaining({ id: 's-2', name: 'Run B', owner: 'Admin', agentName: 'Tower', projectName: 'Tower', snapshotCount: 1, todoTotal: 1, todoDone: 0, todoLeft: 1, runTitles: ['Schema pass'], openTodos: [{ content: 'Update schema', status: 'in_progress' }] }),
      expect.objectContaining({ id: 's-1', name: 'Run A', owner: 'Admin', snapshotCount: 1, todoTotal: 1, todoDone: 1, todoLeft: 0, runTitles: ['Parser pass'], completedTodos: [{ content: 'Implement parser', status: 'completed' }] }),
    ]);
    expect(row?.backlog).toEqual([{ type: 'docs', title: 'Document detail view', priority: 'P2', reason: 'Future UI' }]);
    expect(row?.questions).toEqual([{ title: 'Should backlog render in detail panel?', status: 'open', reason: 'Avoid timeline clutter' }]);
  });

  it('defaults privileged My Work queries to the signed-in user instead of all accessible project work', async () => {
    queryMock.mockResolvedValueOnce([]);
    queryMock.mockResolvedValueOnce([]);

    await getChallengeTimeline({ userId: 42, role: 'admin', rangeHours: 24, bucketHours: 1 });

    const sql = String(queryMock.mock.calls[1]?.[0] || '');
    const values = queryMock.mock.calls[1]?.[1] || [];
    expect(sql).toContain('s.user_id = $');
    expect(values).toContain(42);
  });

  it('migrates legacy v2 TodoWrite epic into the workstream identity and title into runTitle', async () => {
    queryMock.mockResolvedValueOnce([]);
    queryMock.mockResolvedValueOnce([
      {
        session_id: 's-legacy',
        session_name: 'Legacy session',
        project_id: 'p-1',
        project_name: 'Tower',
        owner_user_id: 1,
        owner_name: 'Admin',
        created_at: new Date('2026-06-28T00:00:00.000Z'),
        content: assistantContent({
          work: {
            mode: 'new',
            epic: 'Long-running epic',
            title: 'Legacy run title',
            goal: 'Legacy goal',
          },
          todos: [{ content: 'Legacy task', status: 'completed', activeForm: 'Doing legacy task' }],
        }),
      },
    ]);

    const result = await getChallengeTimeline({ userId: 1, role: 'admin', rangeHours: 24, bucketHours: 1 });
    const row = result.projects[0]?.challenges[0];

    expect(row).toMatchObject({
      title: 'Long Running Epic',
      workstreamKey: 'Long-running epic',
      todoTotal: 1,
      todoDone: 1,
      todoLeft: 0,
      status: 'resolved',
    });
    expect(row?.runTitles).toEqual(['Legacy run title']);
    expect(row?.outcomes).toEqual(['Legacy goal']);
    expect(row?.sessions).toEqual([
      expect.objectContaining({ id: 's-legacy', name: 'Legacy session', owner: 'Admin', snapshotCount: 1, todoTotal: 1, todoDone: 1, todoLeft: 0, runTitles: ['Legacy run title'], openTodos: [], completedTodos: [{ content: 'Legacy task', status: 'completed' }] }),
    ]);
  });

  it('deduplicates WorkLedger and TodoWrite snapshots for the same run', async () => {
    queryMock.mockResolvedValueOnce([
      {
        id: 'wl-dedupe',
        run_id: 'run-dedupe',
        project_id: 'p-1',
        session_id: 's-dedupe',
        owner_user_id: 1,
        workstream_key: 'dedupe-ledger',
        workstream_title: 'Dedupe Ledger',
        run_title: 'Same run',
        outcome: 'One run in My Work',
        note: null,
        source_type: 'process_map',
        source_id: 'pm-dedupe',
        source_refs: {},
        status: 'running',
        artifacts: [],
        backlog: [{ type: 'task', title: 'Ledger backlog' }],
        questions: [{ title: 'Ledger question', status: 'open' }],
        started_at: '2026-06-28T03:00:00.000Z',
        completed_at: null,
        created_at: '2026-06-28T03:00:00.000Z',
        updated_at: '2026-06-28T03:00:00.000Z',
        project_name: 'Tower',
        owner_name: 'Admin',
      },
    ]);
    queryMock.mockResolvedValueOnce([
      {
        session_id: 's-dedupe',
        session_name: 'Same run session',
        project_id: 'p-1',
        project_name: 'Tower',
        owner_user_id: 1,
        owner_name: 'Admin',
        created_at: new Date('2026-06-28T03:05:00.000Z'),
        content: assistantContent({
          work: {
            mode: 'continue',
            workstreamKey: 'dedupe-ledger',
            workstreamTitle: 'Dedupe Ledger',
            runTitle: 'Same run',
            outcome: 'One run in My Work',
          },
          todos: [{ content: 'Do shared work', status: 'in_progress', activeForm: 'Doing shared work' }],
          backlog: [{ type: 'docs', title: 'Todo backlog' }],
          questions: [{ title: 'Todo question', status: 'open' }],
        }),
      },
    ]);

    const result = await getChallengeTimeline({ userId: 1, role: 'admin', rangeHours: 24, bucketHours: 1 });
    const row = result.projects[0]?.challenges[0];

    expect(result.totals.snapshots).toBe(1);
    expect(row).toMatchObject({
      title: 'Dedupe Ledger',
      workstreamKey: 'dedupe-ledger',
      sessionCount: 1,
      todoTotal: 1,
      todoDone: 0,
      todoLeft: 1,
      status: 'active',
    });
    expect(row?.runTitles).toEqual(['Same run']);
    expect(row?.backlog).toEqual(expect.arrayContaining([
      { type: 'task', title: 'Ledger backlog' },
      { type: 'docs', title: 'Todo backlog' },
    ]));
    expect(row?.questions).toEqual(expect.arrayContaining([
      { title: 'Ledger question', status: 'open' },
      { title: 'Todo question', status: 'open' },
    ]));
    expect(row?.sessions).toEqual([
      expect.objectContaining({ id: 's-dedupe', snapshotCount: 1, todoTotal: 1, openTodos: [{ content: 'Do shared work', status: 'in_progress' }] }),
    ]);
  });

  it('uses canonical WorkLedger records even when no TodoWrite snapshot exists', async () => {
    queryMock.mockResolvedValueOnce([
      {
        id: 'wl-1',
        run_id: 'run-1',
        project_id: 'p-1',
        session_id: 's-process',
        owner_user_id: 1,
        workstream_key: 'process-map-ledger',
        workstream_title: 'Process Map Ledger',
        run_title: 'Process-only run',
        outcome: 'Tracked without TodoWrite',
        note: null,
        source_type: 'process_map',
        source_id: 'pm-1',
        source_refs: { processMapId: 'pm-1' },
        status: 'running',
        artifacts: ['~/workspace/projects/tower/final/report.md'],
        backlog: [{ type: 'task', title: 'Promote to skill', priority: 'P2' }],
        questions: [{ title: 'Should this become a code command?', status: 'open' }],
        started_at: '2026-06-28T02:00:00.000Z',
        completed_at: null,
        created_at: '2026-06-28T02:00:00.000Z',
        updated_at: '2026-06-28T02:10:00.000Z',
        project_name: 'Tower',
        owner_name: 'Admin',
      },
    ]);
    queryMock.mockResolvedValueOnce([]);

    const result = await getChallengeTimeline({ userId: 1, role: 'admin', rangeHours: 24, bucketHours: 1 });
    const row = result.projects[0]?.challenges[0];

    expect(result.totals.challenges).toBe(1);
    expect(result.totals.snapshots).toBe(1);
    expect(row).toMatchObject({
      title: 'Process Map Ledger',
      workstreamKey: 'process-map-ledger',
      sessionCount: 1,
      todoTotal: 0,
      todoDone: 0,
      todoLeft: 0,
      status: 'active',
    });
    expect(row?.runTitles).toEqual(['Process-only run']);
    expect(row?.outcomes).toEqual(['Tracked without TodoWrite']);
    expect(row?.backlog).toEqual([{ type: 'task', title: 'Promote to skill', priority: 'P2' }]);
    expect(row?.questions).toEqual([{ title: 'Should this become a code command?', status: 'open' }]);
    expect(row?.sessions).toEqual([
      expect.objectContaining({ id: 's-process', name: 'Process-only run', owner: 'Admin', snapshotCount: 1, todoTotal: 0, todoDone: 0, todoLeft: 0, runTitles: ['Process-only run'] }),
    ]);
  });

  it('projects running ledger records older than seven days as waiting for review', async () => {
    queryMock.mockResolvedValueOnce([
      {
        id: 'wl-stale',
        run_id: 'run-stale',
        project_id: 'p-1',
        session_id: 's-stale',
        owner_user_id: 1,
        workstream_key: 'stale-running',
        workstream_title: 'Stale Running',
        run_title: 'Old unfinished run',
        outcome: 'Do not present stale work as active',
        note: null,
        source_type: 'todowrite',
        source_id: 'todo-stale',
        source_refs: {},
        status: 'running',
        artifacts: [],
        backlog: [],
        questions: [],
        todos: [{ content: 'Finish old work', status: 'in_progress' }],
        activity_at: '2026-06-10T00:00:00.000Z',
        started_at: '2026-06-10T00:00:00.000Z',
        completed_at: null,
        created_at: '2026-06-10T00:00:00.000Z',
        updated_at: '2026-06-10T00:00:00.000Z',
        project_name: 'Tower',
        owner_name: 'Admin',
      },
    ]);
    queryMock.mockResolvedValueOnce([]);

    const result = await getChallengeTimeline({ userId: 1, role: 'admin', rangeHours: 24 * 15, bucketHours: 24 });
    const row = result.projects[0]?.challenges[0];

    expect(row).toMatchObject({
      workstreamKey: 'stale-running',
      status: 'waiting',
      waitingReason: 'stale',
      todoLeft: 1,
    });
  });

  it.each([
    ['blocked', 'blocked'],
    ['failed', 'failed'],
  ] as const)('exposes %s ledger status as a distinct waiting reason', async (ledgerStatus, waitingReason) => {
    queryMock.mockResolvedValueOnce([
      {
        id: `wl-${ledgerStatus}`,
        run_id: `run-${ledgerStatus}`,
        project_id: 'p-1',
        session_id: `s-${ledgerStatus}`,
        owner_user_id: 1,
        workstream_key: `${ledgerStatus}-work`,
        workstream_title: `${ledgerStatus} work`,
        run_title: `${ledgerStatus} run`,
        outcome: null,
        note: null,
        source_type: 'process_map',
        source_id: `pm-${ledgerStatus}`,
        source_refs: {},
        status: ledgerStatus,
        artifacts: [],
        backlog: [],
        questions: [],
        todos: [{ content: 'Resolve work', status: 'pending' }],
        activity_at: '2026-06-28T04:00:00.000Z',
        started_at: '2026-06-28T04:00:00.000Z',
        completed_at: null,
        created_at: '2026-06-28T04:00:00.000Z',
        updated_at: '2026-06-28T04:00:00.000Z',
        project_name: 'Tower',
        owner_name: 'Admin',
      },
    ]);
    queryMock.mockResolvedValueOnce([]);

    const result = await getChallengeTimeline({ userId: 1, role: 'admin', rangeHours: 24, bucketHours: 1 });
    expect(result.projects[0]?.challenges[0]).toMatchObject({
      status: 'waiting',
      waitingReason,
    });
  });

  it('uses unfinished as the waiting reason when pending work has no stronger ledger reason', async () => {
    queryMock.mockResolvedValueOnce([]);
    queryMock.mockResolvedValueOnce([
      {
        session_id: 's-unfinished',
        session_name: 'Unfinished session',
        project_id: 'p-1',
        project_name: 'Tower',
        owner_user_id: 1,
        owner_name: 'Admin',
        created_at: new Date('2026-06-28T04:00:00.000Z'),
        content: assistantContent({
          work: { workstreamKey: 'unfinished', workstreamTitle: 'Unfinished', runTitle: 'Pending run' },
          todos: [{ content: 'Pending step', status: 'pending' }],
        }),
      },
    ]);

    const result = await getChallengeTimeline({ userId: 1, role: 'admin', rangeHours: 24, bucketHours: 1 });
    expect(result.projects[0]?.challenges[0]).toMatchObject({
      status: 'waiting',
      waitingReason: 'unfinished',
    });
  });

  it('defaults privileged My Work queries to the signed-in user and returns the pinned agent identity', async () => {
    queryMock.mockResolvedValueOnce([]);
    queryMock.mockResolvedValueOnce([
      {
        session_id: 's-mine',
        session_name: 'My delegated run',
        project_id: 'p-agent',
        project_name: 'Agent workspace',
        owner_user_id: 7,
        owner_name: 'Current user',
        agent_name: '기록 담당',
        agent_face: 'character:korean-diverse-9',
        created_at: new Date('2026-06-28T04:00:00.000Z'),
        content: assistantContent({
          work: { workstreamKey: 'mine', workstreamTitle: '내 위임 업무', runTitle: '결과 정리' },
          todos: [{ content: '결과 확인', status: 'completed' }],
        }),
      },
    ]);

    const result = await getChallengeTimeline({ userId: 7, role: 'admin', rangeHours: 24, bucketHours: 1 });

    expect(queryMock.mock.calls[1][0]).toContain('s.user_id = $');
    expect(queryMock.mock.calls[1][1]).toContain(7);
    expect(result.projects[0]?.challenges[0]?.sessions[0]).toMatchObject({
      id: 's-mine',
      agentName: '기록 담당',
      agentFace: 'character:korean-diverse-9',
      projectId: 'p-agent',
      projectName: 'Agent workspace',
    });
  });
});
