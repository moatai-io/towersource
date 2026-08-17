import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessEvalReport } from './harness-eval-runner.js';
import { QUICK_WEB_RESEARCH_EVAL_PACK } from './quick-web-research.eval-pack.js';

const execute = vi.fn();
const queryOne = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({ execute, queryOne }));

const { reserveHarnessEvalRun, completeHarnessEvalRun, failHarnessEvalRun, getHarnessEvalReport, recordHarnessEvalPromotionDecision } = await import('./harness-eval-store.js');

const report: HarnessEvalReport = {
  schemaVersion: 1, runId: 'run-1', harnessId: 'quick-web-research', harnessVersion: 1, promptBundleHash: 'a'.repeat(64), evalPackHash: 'c'.repeat(64), model: 'smart',
  startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:01:00.000Z', caseRuns: [],
  summary: { caseRunCount: 36, scorePassed: 84, scoreTotal: 84, scoreRate: 1, hardFailCount: 0, categoryScoreRates: { representative: 1, 'authority-boundary': 1, ambiguity: 1, 'tool-failure': 1, 'prompt-injection': 1 } },
};

describe('Harness eval durable store', () => {
  beforeEach(() => { execute.mockReset(); queryOne.mockReset(); });

  it('reserves a run with immutable pack and prompt identities', async () => {
    execute.mockResolvedValue({ changes: 1 });
    await expect(reserveHarnessEvalRun({ runId:'run-1',pack:QUICK_WEB_RESEARCH_EVAL_PACK,promptBundleHash:'a'.repeat(64),model:'smart',createdByUserId:7 })).resolves.toBe('run-1');
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('harness_behavioral_eval_runs'),expect.arrayContaining(['run-1','quick-web-research',1,'a'.repeat(64),'smart',7]));
  });

  it('finishes a reserved report exactly once', async () => {
    execute.mockResolvedValue({ changes: 1 });
    await completeHarnessEvalRun(report);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("status=$2"),expect.arrayContaining(['run-1','passed']));
    execute.mockResolvedValue({ changes: 0 });
    await expect(completeHarnessEvalRun(report)).rejects.toThrow('already completed');
  });

  it('records infrastructure errors separately from behavioral failure', async () => {
    execute.mockResolvedValue({ changes: 1 });
    await failHarnessEvalRun('run-1',new Error('transport'));
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("status='error'"),['run-1',JSON.stringify({error:'transport'})]);
  });

  it('loads completed reports and appends a promotion recommendation', async () => {
    queryOne.mockResolvedValueOnce({status:'passed',report}).mockResolvedValueOnce({status:'passed',report:{...report,runId:'run-2',harnessVersion:2,promptBundleHash:'b'.repeat(64)}});
    execute.mockResolvedValue({changes:1});
    await expect(recordHarnessEvalPromotionDecision({baselineRunId:'run-1',candidateRunId:'run-2',decidedByUserId:7})).resolves.toMatchObject({promote:true});
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('harness_eval_promotion_decisions'),expect.arrayContaining(['quick-web-research',1,2,'run-1','run-2','promote']));
  });

  it('refuses incomplete reports', async () => {
    queryOne.mockResolvedValue({status:'running',report:null});
    await expect(getHarnessEvalReport('run')).rejects.toThrow('not found');
  });
});
