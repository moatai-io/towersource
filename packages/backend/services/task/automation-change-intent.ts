/**
 * Owns: preview-first, stale-safe, one-time automation configuration changes.
 * Public API: createAutomationChangeIntent(), applyAutomationChangeIntent().
 */
import { createHash } from 'node:crypto';
import { query, queryOne, transaction, withClient } from '../../db/pg-repo.js';
import { materializeAutomationYamlV1, validateAutomationYamlV1 } from '../../../shared/automation-yaml.js';
import { getAutomation, getAutomationInTransaction, getAutomationForUpdateInTransaction, updateAutomationInTransaction, type Automation, type AutomationRiskLevel } from './automation-manager.js';
import { authorizeAutomationMutation } from './automation-mutation-policy.js';
import { canAccessAutomationJob } from './schedule-permissions.js';

export interface AutomationChangeIntent {
  id: string;
  automationId: string;
  projectId: string | null;
  proposedByUserId: number;
  sourceSessionId: string | null;
  baseConfigUpdatedAt: string;
  proposalHash: string;
  yaml: string;
  updates: Record<string, unknown>;
  riskLevel: AutomationRiskLevel;
  warnings: string[];
  summary: string | null;
  status: string;
  expiresAt: string;
  applyingByUserId: number | null;
  applyingAt: string | null;
  appliedByUserId: number | null;
  appliedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapRow(row: any): AutomationChangeIntent {
  return {
    id: row.id,
    automationId: row.automation_id,
    projectId: row.project_id || null,
    proposedByUserId: Number(row.proposed_by_user_id),
    sourceSessionId: row.source_session_id || null,
    baseConfigUpdatedAt: row.base_config_updated_at,
    proposalHash: row.proposal_hash,
    yaml: row.yaml_text,
    updates: row.materialized_updates || {},
    riskLevel: row.risk_level,
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    summary: row.summary || null,
    status: row.status,
    expiresAt: row.expires_at,
    applyingByUserId: row.applying_by_user_id ? Number(row.applying_by_user_id) : null,
    applyingAt: row.applying_at || null,
    appliedByUserId: row.applied_by_user_id ? Number(row.applied_by_user_id) : null,
    appliedAt: row.applied_at || null,
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function automationChangeProposalHash(input: { automationId: string; baseConfigUpdatedAt: string; updates: unknown }): string {
  return createHash('sha256').update(stable(input)).digest('hex');
}

export async function createAutomationChangeIntent(input: {
  automation: Automation;
  actorUserId: number;
  actorRole?: string | null;
  sourceSessionId?: string | null;
  yaml: string;
  summary?: string | null;
}): Promise<AutomationChangeIntent> {
  const access = await canAccessAutomationJob(input.automation, input.actorUserId, input.actorRole, 'propose');
  if (!access.allowed) throw new Error(access.message || 'forbidden');
  const validation = validateAutomationYamlV1(input.yaml);
  if (!validation.ok) throw new Error('invalid automation yaml');
  const materialized = materializeAutomationYamlV1(input.yaml);
  const policy = await authorizeAutomationMutation({
    actor: { userId: input.actorUserId, role: input.actorRole },
    existing: input.automation,
    mutation: {
      projectId: input.automation.projectId,
      jobType: materialized.updates.jobType,
      scopeType: input.automation.scopeType,
      definitionJson: materialized.updates.definitionJson,
      // Preview must be issuable even when applying the change will require high-risk confirmation.
      confirmedHighRisk: true,
    },
  });
  if (!policy.allowed || !policy.riskLevel) throw new Error(policy.message || 'forbidden');

  const updates = { ...materialized.updates, riskLevel: policy.riskLevel } as Record<string, unknown>;
  const proposalHash = automationChangeProposalHash({
    automationId: input.automation.id,
    baseConfigUpdatedAt: input.automation.configUpdatedAt,
    updates,
  });
  const row = await queryOne<any>(
    `INSERT INTO automation_change_intents(
       automation_id,project_id,proposed_by_user_id,source_session_id,base_config_updated_at,
       proposal_hash,yaml_text,materialized_updates,risk_level,warnings,summary
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11) RETURNING *`,
    [input.automation.id, input.automation.projectId, input.actorUserId, input.sourceSessionId || null,
      input.automation.configUpdatedAt, proposalHash, input.yaml, JSON.stringify(updates), policy.riskLevel,
      JSON.stringify(materialized.warnings), input.summary || null],
  );
  if (!row) throw new Error('failed to create automation change intent');
  return mapRow(row);
}

export async function getAutomationChangeIntentDiagnostics(input: {
  automationId: string;
  actorUserId: number;
  actorRole?: string | null;
}): Promise<AutomationChangeIntent[]> {
  const automation = await getAutomation(input.automationId);
  if (!automation) throw new Error('automation not found');
  const access = await canAccessAutomationJob(automation, input.actorUserId, input.actorRole, 'read');
  if (!access.allowed) throw new Error(access.message || 'forbidden');
  const rows = await query<any>(
    `SELECT * FROM automation_change_intents
      WHERE automation_id=$1 AND status IN ('proposed','applying','failed')
      ORDER BY created_at DESC LIMIT 20`,
    [input.automationId],
  );
  return rows.map(mapRow);
}

const RECONCILE_MIN_AGE_MS = 2 * 60 * 1000;

function automationConfigSnapshot(automation: Automation): Record<string, unknown> {
  return {
    name: automation.name, description: automation.description, prompt: automation.prompt, model: automation.model,
    workflow: automation.workflow, jobType: automation.jobType, scopeType: automation.scopeType,
    definitionJson: automation.definitionJson, riskLevel: automation.riskLevel, timeoutSeconds: automation.timeoutSeconds,
    timezone: automation.timezone, mode: automation.mode, targetId: automation.targetId, cwd: automation.cwd,
    triggerType: automation.triggerType, cronConfig: automation.cronConfig, onceAt: automation.onceAt,
    enabled: automation.enabled, sortOrder: automation.sortOrder, projectId: automation.projectId,
  };
}

export async function reconcileAutomationChangeIntent(input: {
  intentId: string;
  automationId: string;
  actorUserId: number;
  actorRole?: string | null;
  now?: Date;
}): Promise<{ intent: AutomationChangeIntent; outcome: 'applied' | 'failed'; reason: string }> {
  return transaction(async (client) => {
    const db = withClient(client);
    const row = await db.queryOne<any>(
      `SELECT * FROM automation_change_intents WHERE id=$1 AND automation_id=$2 FOR UPDATE`,
      [input.intentId, input.automationId],
    );
    if (!row) throw new Error('automation change intent not found');
    const intent = mapRow(row);
    const current = await getAutomationInTransaction(client, input.automationId);
    if (!current) throw new Error('automation not found');
    const access = await canAccessAutomationJob(current, input.actorUserId, input.actorRole, 'edit');
    if (!access.allowed) throw new Error(access.message || 'forbidden');
    if (intent.status !== 'applying') throw new Error('automation change intent is not applying');
    if (!intent.applyingAt || !intent.applyingByUserId) throw new Error('automation change intent lacks applying provenance');
    const now = input.now || new Date();
    if (now.getTime() - new Date(intent.applyingAt).getTime() < RECONCILE_MIN_AGE_MS) {
      throw new Error('automation change intent may still be applying');
    }

    const revision = await db.queryOne<any>(
      `SELECT id,actor_user_id,config_updated_at FROM automation_config_revisions
        WHERE automation_id=$1 AND change_intent_id=$2`,
      [input.automationId, intent.id],
    );
    const applied = Boolean(revision);
    const reason = applied
      ? 'reconciled from exact change-intent revision ledger evidence'
      : 'no automation config revision is bound to this change intent';
    const nextStatus = applied ? 'applied' : 'failed';
    const completed = await db.queryOne<any>(
      `UPDATE automation_change_intents
          SET status=$2,applied_by_user_id=CASE WHEN $2='applied' THEN applying_by_user_id ELSE applied_by_user_id END,
              applied_at=CASE WHEN $2='applied' THEN COALESCE(applied_at,applying_at,NOW()) ELSE applied_at END,
              error=CASE WHEN $2='failed' THEN $3 ELSE NULL END,updated_at=NOW()
        WHERE id=$1 AND status='applying' RETURNING *`,
      [intent.id, nextStatus, reason],
    );
    if (!completed) throw new Error('automation change intent reconciliation lost its claim');
    return { intent: mapRow(completed), outcome: nextStatus, reason };
  });
}

export async function applyAutomationChangeIntent(input: {
  intentId: string;
  automationId: string;
  actorUserId: number;
  actorRole?: string | null;
  proposalHash: string;
  confirmedHighRisk?: boolean;
}): Promise<{ intent: AutomationChangeIntent; automation: Automation }> {
  return transaction(async (client) => {
    const db = withClient(client);
    const row = await db.queryOne<any>(
      `SELECT * FROM automation_change_intents WHERE id=$1 AND automation_id=$2 FOR UPDATE`,
      [input.intentId, input.automationId],
    );
    if (!row) throw new Error('automation change intent not found');
    const intent = mapRow(row);
    if (intent.status !== 'proposed') throw new Error('automation change intent is not unused');
    if (new Date(intent.expiresAt).getTime() <= Date.now()) throw new Error('automation change intent expired');
    if (intent.proposalHash !== input.proposalHash) throw new Error('automation change proposal hash mismatch');

    const current = await getAutomationForUpdateInTransaction(client, input.automationId);
    if (!current) throw new Error('automation not found');
    const access = await canAccessAutomationJob(current, input.actorUserId, input.actorRole, 'edit');
    if (!access.allowed) throw new Error(access.message || 'forbidden');
    if (new Date(current.configUpdatedAt).getTime() !== new Date(intent.baseConfigUpdatedAt).getTime()) {
      throw new Error('automation changed after this proposal; create a new preview');
    }

    const updates = intent.updates as any;
    const policy = await authorizeAutomationMutation({
      actor: { userId: input.actorUserId, role: input.actorRole },
      existing: current,
      mutation: {
        projectId: updates.projectId,
        jobType: updates.jobType,
        scopeType: updates.scopeType,
        definitionJson: updates.definitionJson,
        confirmedHighRisk: input.confirmedHighRisk === true,
      },
    });
    if (!policy.allowed || !policy.riskLevel) throw new Error(policy.message || 'forbidden');

    const claimed = await db.queryOne<any>(
      `UPDATE automation_change_intents
          SET status='applying',applying_by_user_id=$2,applying_at=NOW(),error=NULL,updated_at=NOW()
        WHERE id=$1 AND status='proposed' RETURNING *`,
      [intent.id, input.actorUserId],
    );
    if (!claimed) throw new Error('automation change intent was already consumed');

    const changed = await updateAutomationInTransaction(client, current.id, {
      ...updates,
      riskLevel: policy.riskLevel,
      updatedByUserId: input.actorUserId,
    });
    if (!changed) throw new Error('automation update failed');
    const revision = await db.queryOne<any>(
      `INSERT INTO automation_config_revisions(
         automation_id,revision_no,change_intent_id,actor_user_id,base_config_updated_at,
         config_updated_at,proposal_hash,materialized_updates,config_snapshot
       ) VALUES($1,
         COALESCE((SELECT MAX(revision_no)+1 FROM automation_config_revisions WHERE automation_id=$1),1),
         $2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) RETURNING id`,
      [current.id, intent.id, input.actorUserId, intent.baseConfigUpdatedAt, changed.configUpdatedAt,
        intent.proposalHash, JSON.stringify({ ...updates, riskLevel: policy.riskLevel }), JSON.stringify(automationConfigSnapshot(changed))],
    );
    if (!revision) throw new Error('automation config revision insert failed');
    const appliedRow = await db.queryOne<any>(
      `UPDATE automation_change_intents
          SET status='applied',applied_by_user_id=$2,applied_at=NOW(),updated_at=NOW()
        WHERE id=$1 AND status='applying' RETURNING *`,
      [intent.id, input.actorUserId],
    );
    if (!appliedRow) throw new Error('automation change intent completion failed');
    return { intent: mapRow(appliedRow), automation: changed };
  });
}
