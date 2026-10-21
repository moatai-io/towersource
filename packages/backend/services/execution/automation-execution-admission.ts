import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { transaction, withClient } from '../../db/pg-repo.js';
import type { Automation } from '../task/automation-manager.js';
import { admitExecutionWithDb } from './execution-manager.js';
import type { ExecutionAdapterKind, ExecutionRecord } from './execution-types.js';

export interface AdmitAutomationExecutionInput {
  automation: Automation;
  trigger: 'schedule' | 'manual' | 'event';
  idempotencyKey: string;
  dueAt?: string | null;
  adapterKind: ExecutionAdapterKind;
}

export interface AdmittedAutomationExecution {
  execution: ExecutionRecord;
  automationRunId: string;
  created: boolean;
}

export async function admitAutomationExecution(
  input: AdmitAutomationExecutionInput,
  transact: typeof transaction = transaction,
): Promise<AdmittedAutomationExecution> {
  return transact(async (client: PoolClient) => {
    const db = withClient(client);
    const runId = uuidv4();
    const scopeKind = input.automation.scopeType === 'personal'
      ? 'personal'
      : input.automation.projectId
        ? 'project'
        : 'system';

    const admitted = await admitExecutionWithDb(db, {
      sourceKind: 'automation',
      sourceId: input.automation.id,
      sourceRunId: null,
      scopeKind,
      projectId: scopeKind === 'project' ? input.automation.projectId : null,
      actorUserId: input.automation.userId,
      adapterKind: input.adapterKind,
      engine: input.automation.jobType === 'ai_prompt' ? undefined : null,
      model: input.automation.model,
      idempotencyKey: input.idempotencyKey,
      inputJson: {
        trigger: input.trigger,
        dueAt: input.dueAt || null,
        jobType: input.automation.jobType,
        mode: input.automation.mode,
      },
    });

    const existingRun = await db.queryOne<{ id: string }>(
      'SELECT id FROM automation_runs WHERE execution_id = $1',
      [admitted.execution.id],
    );
    if (existingRun) {
      return { execution: admitted.execution, automationRunId: existingRun.id, created: false };
    }

    await db.execute(`
      INSERT INTO automation_runs (
        id, automation_id, execution_id, status, mode, result_id, error, duration_ms,
        trigger, started_at, finished_at, summary_text, error_json, runner_kind, runner_ref, ran_at
      ) VALUES (
        $1, $2, $3, 'admitted', $4, NULL, NULL, NULL,
        $5, NULL, NULL, NULL, NULL, 'system', NULL, NOW()
      )
    `, [runId, input.automation.id, admitted.execution.id, input.automation.mode, input.trigger]);

    await db.execute(
      'UPDATE executions SET source_run_id = $2, updated_at = NOW() WHERE id = $1 AND source_run_id IS NULL',
      [admitted.execution.id, runId],
    );

    return {
      execution: { ...admitted.execution, sourceRunId: runId },
      automationRunId: runId,
      created: true,
    };
  });
}
