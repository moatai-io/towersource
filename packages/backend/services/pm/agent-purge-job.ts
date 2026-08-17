// Owns: durable permanent Agent deletion jobs.
// Public API: createAgentPurgeJob, runAgentPurgeJob, getAgentPurgeJob. See agent-purge-preview.ts.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { execute, query, queryOne, transaction, withClient } from '../../db/pg-repo.js';
import { stopBox } from '../runtime-box/runtime-box-manager.js';

export type AgentPurgeJobStatus = 'approved' | 'running' | 'completed' | 'failed_before_destructive' | 'recovery_required';

type JobRow = {
  id: string; project_id: string | null; project_id_snapshot: string; project_name_snapshot: string;
  root_path_snapshot: string | null; actor_user_id: number; preview_intent_id: string; proposal_hash: string;
  status: AgentPurgeJobStatus; stage: string; attempt_count: number; quarantine_path: string | null;
  impact_snapshot: any; result: any; last_error: string | null; created_at: string; updated_at: string;
};

function assertSafeProjectPath(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  const projectsRoot = path.resolve(config.workspaceRoot, 'projects');
  if (resolved === projectsRoot || !resolved.startsWith(`${projectsRoot}${path.sep}`)) {
    throw new Error('PROJECT_PATH_OUTSIDE_MANAGED_ROOT');
  }
  return resolved;
}

function quarantineTarget(projectId: string): string {
  return path.join(path.resolve(config.workspaceRoot, '.agent-purge-quarantine'), `${projectId}-${Date.now()}`);
}

async function updateJob(id: string, fields: { status?: AgentPurgeJobStatus; stage?: string; quarantinePath?: string | null; error?: string | null; result?: unknown }) {
  await execute(`UPDATE agent_purge_jobs SET status=COALESCE($2,status), stage=COALESCE($3,stage),
    quarantine_path=COALESCE($4,quarantine_path), last_error=$5,
    result=CASE WHEN $6::jsonb IS NULL THEN result ELSE result || $6::jsonb END,
    started_at=CASE WHEN started_at IS NULL AND $2='running' THEN NOW() ELSE started_at END,
    completed_at=CASE WHEN $2='completed' THEN NOW() ELSE completed_at END, updated_at=NOW()
    WHERE id=$1`, [id, fields.status ?? null, fields.stage ?? null, fields.quarantinePath ?? null, fields.error ?? null, fields.result === undefined ? null : JSON.stringify(fields.result)]);
}

/** Validate an exact, unused preview and create one durable approved job. No deletion occurs here. */
export async function createAgentPurgeJob(input: { projectId: string; actorUserId: number; intentId: string; proposalHash: string; typedName: string; confirmed: true }) {
  if (input.confirmed !== true) throw new Error('EXPLICIT_CONFIRMATION_REQUIRED');
  return transaction(async client => {
    const db = withClient(client);
    const intent = await db.queryOne<any>(`SELECT i.*,p.name,p.root_path,COALESCE(p.lifecycle_status,'active') AS current_lifecycle
      FROM agent_purge_preview_intents i JOIN projects p ON p.id=i.project_id
      WHERE i.id=$1 AND i.project_id=$2 AND i.actor_user_id=$3 AND i.proposal_hash=$4 AND i.expires_at>NOW() FOR UPDATE`,
    [input.intentId, input.projectId, input.actorUserId, input.proposalHash]);
    if (!intent) throw new Error('VALID_UNUSED_PREVIEW_REQUIRED');
    if (intent.current_lifecycle !== 'retired' || intent.lifecycle_status !== 'retired') throw new Error('AGENT_MUST_BE_RETIRED');
    if (input.typedName !== intent.name) throw new Error('TYPED_AGENT_NAME_MISMATCH');
    const snapshot = typeof intent.impact_snapshot === 'string' ? JSON.parse(intent.impact_snapshot) : intent.impact_snapshot;
    if ((snapshot?.blockers?.length ?? 0) > 0) throw new Error('PURGE_PREVIEW_HAS_BLOCKERS');
    const row = await db.queryOne<any>(`INSERT INTO agent_purge_jobs
      (project_id,project_id_snapshot,project_name_snapshot,root_path_snapshot,actor_user_id,preview_intent_id,proposal_hash,impact_snapshot)
      VALUES($1,$1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(preview_intent_id) DO NOTHING RETURNING *`,
    [input.projectId, intent.name, intent.root_path, input.actorUserId, input.intentId, input.proposalHash, JSON.stringify(snapshot)]);
    if (!row) throw new Error('PREVIEW_ALREADY_CONSUMED');
    await db.execute("UPDATE projects SET lifecycle_status='purge_pending' WHERE id=$1 AND lifecycle_status='retired'", [input.projectId]);
    return row as JobRow;
  });
}

export async function getAgentPurgeJob(jobId: string): Promise<JobRow | undefined> {
  return queryOne<JobRow>('SELECT * FROM agent_purge_jobs WHERE id=$1', [jobId]);
}

async function cleanupDedicatedCredentials(projectId: string) {
  const credentials = await query<{ id: string; secret_name: string }>(`SELECT id,secret_name FROM workspace_credentials
    WHERE scope='project' AND metadata->>'agent_project_id'=$1`, [projectId]);
  for (const credential of credentials) {
    const otherCredential = await queryOne(`SELECT id FROM workspace_credentials WHERE secret_name=$1 AND id<>$2 LIMIT 1`, [credential.secret_name, credential.id]);
    if (otherCredential) throw new Error(`SHARED_SECRET_NAME:${credential.id}`);
  }
  for (const credential of credentials) {
    await execute('DELETE FROM workspace_credentials WHERE id=$1', [credential.id]);
    await execute(`DELETE FROM secret_store WHERE name=$1 AND NOT EXISTS (SELECT 1 FROM workspace_credentials WHERE secret_name=$1)`, [credential.secret_name]);
  }
  return credentials.length;
}

async function purgeDatabase(projectId: string) {
  return transaction(async client => {
    const db = withClient(client);
    await db.execute('DELETE FROM ai_services WHERE owner_project_id=$1', [projectId]);
    await db.execute('DELETE FROM sessions WHERE project_id=$1', [projectId]);
    await db.execute('DELETE FROM tasks WHERE project_id=$1', [projectId]);
    await db.execute('DELETE FROM session_memory_cards WHERE project_id=$1', [projectId]);
    await db.execute('DELETE FROM agent_workers WHERE project_id=$1', [projectId]);
    await db.execute('DELETE FROM agent_events WHERE project_id=$1', [projectId]);
    await db.execute('UPDATE chat_rooms SET archived=1,project_id=NULL WHERE project_id=$1', [projectId]);
    await db.execute('DELETE FROM projects WHERE id=$1', [projectId]);
  });
}

/** Run or retry one approved job. Stages are idempotent; post-quarantine failures require recovery/retry. */
export async function runAgentPurgeJob(jobId: string) {
  const claimed = await queryOne<JobRow>(`UPDATE agent_purge_jobs SET status='running',attempt_count=attempt_count+1,updated_at=NOW()
    WHERE id=$1 AND status IN ('approved','failed_before_destructive','recovery_required') RETURNING *`, [jobId]);
  if (!claimed) throw new Error('PURGE_JOB_NOT_RUNNABLE');
  let destructive = Boolean(claimed.quarantine_path);
  try {
    await updateJob(jobId, { status: 'running', stage: 'quiescing', error: null });
    const boxes = await query<{ id: number }>('SELECT id FROM project_runtime_boxes WHERE project_id=$1', [claimed.project_id_snapshot]);
    for (const box of boxes) await stopBox(box.id, 'stopped');

    let quarantinePath = claimed.quarantine_path;
    if (!quarantinePath && claimed.root_path_snapshot && fs.existsSync(claimed.root_path_snapshot)) {
      const source = assertSafeProjectPath(claimed.root_path_snapshot);
      quarantinePath = quarantineTarget(claimed.project_id_snapshot);
      fs.mkdirSync(path.dirname(quarantinePath), { recursive: true });
      fs.renameSync(source, quarantinePath);
      destructive = true;
      await updateJob(jobId, { stage: 'filesystem_quarantined', quarantinePath, result: { filesystemQuarantined: true } });
    }

    await updateJob(jobId, { stage: 'credential_cleanup' });
    const credentialCount = await cleanupDedicatedCredentials(claimed.project_id_snapshot);
    destructive = destructive || credentialCount > 0;
    await updateJob(jobId, { stage: 'database_purging', result: { dedicatedCredentialsDeleted: credentialCount } });
    await purgeDatabase(claimed.project_id_snapshot);
    destructive = true;

    if (quarantinePath && fs.existsSync(quarantinePath)) fs.rmSync(quarantinePath, { recursive: true, force: false });
    const remains = await queryOne('SELECT id FROM projects WHERE id=$1', [claimed.project_id_snapshot]);
    if (remains) throw new Error('PROJECT_ROW_REMAINS_AFTER_PURGE');
    await updateJob(jobId, { status: 'completed', stage: 'verified', error: null, result: { verified: true, filesystemDeleted: true } });
    return getAgentPurgeJob(jobId);
  } catch (error: any) {
    await updateJob(jobId, { status: destructive ? 'recovery_required' : 'failed_before_destructive', stage: destructive ? 'recovery_required' : 'failed_before_destructive', error: String(error?.message ?? error).slice(0, 2000) });
    throw error;
  }
}
