import { transaction, withClient } from '../../db/pg-repo.js';
import {
  getAutomationForUpdateInTransaction,
  updateAutomationInTransaction,
  type Automation,
} from './automation-manager.js';

export interface LegacyDirectApplyAuthorization {
  allowed: boolean;
  status?: number;
  message?: string;
  reason?: string;
}

export function authorizeLegacyDirectAutomationApply(input: {
  role?: string | null;
  confirmed?: boolean;
  reason?: unknown;
}): LegacyDirectApplyAuthorization {
  if (input.role !== 'admin' && input.role !== 'operator') {
    return { allowed: false, status: 403, message: 'direct automation YAML apply is operator-only; use a change intent' };
  }
  if (input.confirmed !== true) {
    return { allowed: false, status: 400, message: 'legacy direct apply requires explicit confirmation' };
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 10) {
    return { allowed: false, status: 400, message: 'legacy direct apply requires an audit reason of at least 10 characters' };
  }
  return { allowed: true, reason };
}

function configSnapshot(automation: Automation): Record<string, unknown> {
  return {
    name: automation.name, description: automation.description, prompt: automation.prompt, model: automation.model,
    workflow: automation.workflow, jobType: automation.jobType, scopeType: automation.scopeType,
    definitionJson: automation.definitionJson, riskLevel: automation.riskLevel, timeoutSeconds: automation.timeoutSeconds,
    timezone: automation.timezone, mode: automation.mode, targetId: automation.targetId, cwd: automation.cwd,
    triggerType: automation.triggerType, cronConfig: automation.cronConfig, onceAt: automation.onceAt,
    enabled: automation.enabled, sortOrder: automation.sortOrder, projectId: automation.projectId,
  };
}

export async function applyLegacyAutomationConfig(input: {
  automationId: string;
  actorUserId: number;
  expectedConfigUpdatedAt: string;
  updates: Record<string, unknown>;
  reason: string;
}): Promise<Automation> {
  return transaction(async (client) => {
    const db = withClient(client);
    const current = await getAutomationForUpdateInTransaction(client, input.automationId);
    if (!current) throw new Error('automation not found');
    if (new Date(current.configUpdatedAt).getTime() !== new Date(input.expectedConfigUpdatedAt).getTime()) {
      throw new Error('automation changed before legacy direct apply; retry from the latest revision');
    }
    const changed = await updateAutomationInTransaction(client, current.id, {
      ...input.updates as any,
      updatedByUserId: input.actorUserId,
    });
    if (!changed) throw new Error('automation update failed');
    const revision = await db.queryOne<any>(
      `INSERT INTO automation_config_revisions(
         automation_id,revision_no,change_intent_id,actor_user_id,base_config_updated_at,
         config_updated_at,proposal_hash,materialized_updates,config_snapshot,mutation_source,reason
       ) VALUES($1,
         COALESCE((SELECT MAX(revision_no)+1 FROM automation_config_revisions WHERE automation_id=$1),1),
         NULL,$2,$3,$4,NULL,$5::jsonb,$6::jsonb,'legacy_direct',$7) RETURNING id`,
      [current.id, input.actorUserId, current.configUpdatedAt, changed.configUpdatedAt,
        JSON.stringify(input.updates), JSON.stringify(configSnapshot(changed)), input.reason],
    );
    if (!revision) throw new Error('automation config revision insert failed');
    return changed;
  });
}
