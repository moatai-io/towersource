/**
 * Owns: durable behavioral eval run reports and differential promotion decisions.
 * Public API: reserveHarnessEvalRun, completeHarnessEvalRun, getHarnessEvalReport, recordHarnessEvalPromotionDecision.
 */
import { randomUUID } from 'node:crypto';
import { execute, query, queryOne } from '../../db/pg-repo.js';
import { compareHarnessEvalReports, harnessEvalPackHash, type HarnessEvalPromotionDecision, type HarnessEvalReport } from './harness-eval-runner.js';
import type { HarnessEvalPack } from './harness-eval-pack.js';

/** Reserve one immutable run identity before expensive model calls begin. */
export async function reserveHarnessEvalRun(input: {
  runId?: string;
  pack: HarnessEvalPack;
  promptBundleHash: string;
  model: string;
  createdByUserId?: number;
}): Promise<string> {
  const runId = input.runId ?? randomUUID();
  await execute(
    `INSERT INTO harness_behavioral_eval_runs
       (id,harness_id,harness_version,prompt_bundle_hash,eval_pack_hash,model,status,created_by_user_id)
     VALUES($1,$2,$3,$4,$5,$6,'running',$7)`,
    [runId,input.pack.harnessId,input.pack.harnessVersion,input.promptBundleHash,harnessEvalPackHash(input.pack),input.model,input.createdByUserId ?? null],
  );
  return runId;
}

/** Finish a reserved run exactly once with its complete immutable report. */
export async function completeHarnessEvalRun(report: HarnessEvalReport): Promise<void> {
  const status = report.summary.hardFailCount === 0 ? 'passed' : 'failed';
  const result = await execute(
    `UPDATE harness_behavioral_eval_runs SET status=$2,report=$3::jsonb,completed_at=NOW()
      WHERE id=$1 AND status='running' AND harness_id=$4 AND harness_version=$5
        AND prompt_bundle_hash=$6 AND eval_pack_hash=$7 AND model=$8`,
    [report.runId,status,JSON.stringify(report),report.harnessId,report.harnessVersion,report.promptBundleHash,report.evalPackHash,report.model],
  );
  if (result.changes !== 1) throw new Error(`Harness eval run ${report.runId} is missing, stale, or already completed`);
}

/** Mark a reserved run as infrastructure error without fabricating an eval report. */
export async function failHarnessEvalRun(runId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await execute(
    `UPDATE harness_behavioral_eval_runs SET status='error',report=$2::jsonb,completed_at=NOW() WHERE id=$1 AND status='running'`,
    [runId,JSON.stringify({ error: message })],
  );
}

/** Load one completed report for deterministic differential comparison. */
export async function getHarnessEvalReport(runId: string): Promise<HarnessEvalReport> {
  const row = await queryOne<{ report: unknown; status: string }>('SELECT report,status FROM harness_behavioral_eval_runs WHERE id=$1',[runId]);
  if (!row || (row.status !== 'passed' && row.status !== 'failed') || !row.report || typeof row.report !== 'object') throw new Error(`Completed Harness eval report not found: ${runId}`);
  return row.report as HarnessEvalReport;
}

/** List recent durable eval runs for one Harness identity. */
export async function listHarnessEvalRuns(harnessId:string,limit=20){return query<any>(`SELECT id,harness_id,harness_version,prompt_bundle_hash,eval_pack_hash,model,status,created_by_user_id,started_at,completed_at,report FROM harness_behavioral_eval_runs WHERE harness_id=$1 ORDER BY started_at DESC LIMIT $2`,[harnessId,Math.max(1,Math.min(100,limit))]);}

/** Compare two persisted reports and append an auditable promotion recommendation. */
export async function recordHarnessEvalPromotionDecision(input: {
  baselineRunId: string;
  candidateRunId: string;
  decidedByUserId?: number;
  maxScoreRegression?: number;
  maxCategoryRegression?: number;
}): Promise<HarnessEvalPromotionDecision> {
  const baseline = await getHarnessEvalReport(input.baselineRunId);
  const candidate = await getHarnessEvalReport(input.candidateRunId);
  const comparison = compareHarnessEvalReports({ baseline,candidate,maxScoreRegression:input.maxScoreRegression,maxCategoryRegression:input.maxCategoryRegression });
  const decisionHarnessVersion = candidate.harnessVersion;
  await execute(
    `INSERT INTO harness_eval_promotion_decisions
       (harness_id,baseline_harness_version,candidate_harness_version,baseline_run_id,candidate_run_id,decision,comparison,decided_by_user_id)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [candidate.harnessId,baseline.harnessVersion,decisionHarnessVersion,input.baselineRunId,input.candidateRunId,comparison.promote?'promote':'reject',JSON.stringify(comparison),input.decidedByUserId ?? null],
  );
  return comparison;
}
