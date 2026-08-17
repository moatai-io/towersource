import { describe, expect, it, vi } from 'vitest';

const { upsertWorkLedgerRecordMock } = vi.hoisted(() => ({
  upsertWorkLedgerRecordMock: vi.fn(),
}));

vi.mock('../services/work/work-ledger.js', () => ({
  upsertWorkLedgerRecord: upsertWorkLedgerRecordMock,
}));

import { createProcessMapWriteTool } from './pi-process-map-tool.js';

describe('ProcessMapWrite guidance', () => {
  it('defaults artifact-producing work to artifact-centered maps', () => {
    const tool = createProcessMapWriteTool({ sessionId: 's1', projectId: 'p1', userId: 7 });
    const guidelines = (tool as any).promptGuidelines.join('\n');

    expect(guidelines).toContain('artifact-centered map');
    expect(guidelines).toContain('intended artifact sections, capabilities, contracts, and completion state');
    expect(guidelines).toContain('purpose/JTBD, trigger and non-trigger boundary, core workflow, output contract, validation state, and remaining gaps');
    expect(guidelines).toContain('Use execution-centered maps for risky operations, deployments, external integrations, debugging workflows');
  });
});

describe('ProcessMapWrite WorkLedger integration', () => {
  it('writes WorkLedger when work metadata is provided', async () => {
    upsertWorkLedgerRecordMock.mockResolvedValue({ id: 'wl-1' });
    const tool = createProcessMapWriteTool({ sessionId: 's1', projectId: 'p1', userId: 7 });

    const result = await tool.execute('toolu-1', {
      title: '자동화 지도',
      status: 'completed',
      scope: { type: 'command', command: '/skill-architect', invocationId: 'cmd-1' },
      work: {
        workstreamKey: 'process-map-automation',
        workstreamTitle: 'Process Map Automation',
        runTitle: 'ProcessMapWrite ledger write',
        outcome: 'Ledger is written without TodoWrite duplication',
        backlog: [{ type: 'test', title: 'Add de-dupe test' }],
        questions: [{ title: 'Should command invocation create ledger first?', status: 'open' }],
      },
      steps: [
        { id: 'map', label: '지도 작성', status: 'completed', evidence: { files: ['~/workspace/projects/tower/final/map.md'], artifacts: ['artifact:map'] } },
      ],
    } as any);

    expect(upsertWorkLedgerRecordMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'cmd-1',
      projectId: 'p1',
      sessionId: 's1',
      ownerUserId: 7,
      workstreamKey: 'process-map-automation',
      sourceType: 'process_map',
      sourceId: 'cmd-1',
      status: 'completed',
      artifacts: ['artifact:map', '~/workspace/projects/tower/final/map.md'],
    }));
    expect((result as any).content[0].text).toContain('WorkLedger updated');
  });

  it('does not write WorkLedger without work metadata', async () => {
    upsertWorkLedgerRecordMock.mockReset();
    const tool = createProcessMapWriteTool({ sessionId: 's1', projectId: 'p1', userId: 7 });

    await tool.execute('toolu-2', {
      title: '표시만 하는 지도',
      status: 'running',
      steps: [{ id: 'view', label: '보기', status: 'running' }],
    } as any);

    expect(upsertWorkLedgerRecordMock).not.toHaveBeenCalled();
  });
});
