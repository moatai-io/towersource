// Owns: read-only Agent lifecycle administration and purge impact previews.
// Public API: listAdminAgents, previewAgentPurge. Permanent deletion is intentionally absent.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { query, queryOne } from '../../db/pg-repo.js';

export type AdminAgentLifecycleFilter = 'active' | 'retired';

export interface AdminAgentListItem {
  id: string;
  name: string;
  rootPath: string | null;
  lifecycleStatus: string;
  retiredAt: string | null;
  retirementReason: string | null;
  ownerUsername: string | null;
  sessionCount: number;
  runtimeBoxCount: number;
}

export interface AgentPurgeImpact {
  projectId: string;
  projectName: string;
  lifecycleStatus: string;
  rootPath: string | null;
  folder: { exists: boolean; bytes: number | null; measurement: 'measured' | 'missing' | 'unavailable' };
  database: {
    sessions: number;
    messages: number;
    projectMembers: number;
    runtimeBoxes: number;
    agentWorkers: number;
    agentEvents: number;
    aiServices: number;
  };
  credentials: { dedicated: number; shared: number; reviewRequired: number };
  blockers: string[];
  warnings: string[];
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function measureDirectory(rootPath: string | null): AgentPurgeImpact['folder'] {
  if (!rootPath || !fs.existsSync(rootPath)) return { exists: false, bytes: null, measurement: 'missing' };
  try {
    let bytes = 0;
    const stack = [rootPath];
    while (stack.length) {
      const current = stack.pop()!;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const target = `${current}/${entry.name}`;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) stack.push(target);
        else if (entry.isFile()) bytes += fs.statSync(target).size;
      }
    }
    return { exists: true, bytes, measurement: 'measured' };
  } catch {
    return { exists: true, bytes: null, measurement: 'unavailable' };
  }
}

/** List registered Agents for the admin lifecycle surface. Orphans are handled by a separate evidence scanner. */
export async function listAdminAgents(status: AdminAgentLifecycleFilter): Promise<AdminAgentListItem[]> {
  const lifecycle = status === 'retired' ? 'retired' : 'active';
  const rows = await query<any>(`
    SELECT p.id, p.name, p.root_path, COALESCE(p.lifecycle_status, 'active') AS lifecycle_status,
           p.retired_at, p.retirement_reason, u.username AS owner_username,
           (SELECT COUNT(*)::int FROM sessions s WHERE s.project_id = p.id) AS session_count,
           (SELECT COUNT(*)::int FROM project_runtime_boxes rb WHERE rb.project_id = p.id) AS runtime_box_count
      FROM projects p
      LEFT JOIN users u ON u.id = p.user_id
     WHERE COALESCE(p.lifecycle_status, 'active') = $1
     ORDER BY CASE WHEN $1 = 'retired' THEN p.retired_at ELSE p.created_at END DESC NULLS LAST
  `, [lifecycle]);
  return rows.map(row => ({
    id: row.id, name: row.name, rootPath: row.root_path ?? null,
    lifecycleStatus: row.lifecycle_status, retiredAt: row.retired_at ?? null,
    retirementReason: row.retirement_reason ?? null, ownerUsername: row.owner_username ?? null,
    sessionCount: Number(row.session_count ?? 0), runtimeBoxCount: Number(row.runtime_box_count ?? 0),
  }));
}

/** Create a short-lived immutable preview. This function never deletes or stops resources. */
export async function previewAgentPurge(projectId: string, actorUserId: number) {
  const project = await queryOne<any>(`SELECT id,name,root_path,COALESCE(lifecycle_status,'active') AS lifecycle_status FROM projects WHERE id=$1`, [projectId]);
  if (!project) return null;

  const counts = await queryOne<any>(`
    SELECT
      (SELECT COUNT(*)::int FROM sessions WHERE project_id=$1) AS sessions,
      (SELECT COUNT(*)::int FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.project_id=$1) AS messages,
      (SELECT COUNT(*)::int FROM project_members WHERE project_id=$1) AS project_members,
      (SELECT COUNT(*)::int FROM project_runtime_boxes WHERE project_id=$1) AS runtime_boxes,
      (SELECT COUNT(*)::int FROM agent_workers WHERE project_id=$1) AS agent_workers,
      (SELECT COUNT(*)::int FROM agent_events WHERE project_id=$1) AS agent_events,
      (SELECT COUNT(*)::int FROM ai_services WHERE owner_project_id=$1) AS ai_services,
      (SELECT COUNT(*)::int FROM workspace_credentials WHERE scope='project' AND metadata->>'agent_project_id'=$1) AS dedicated_credentials,
      (SELECT COUNT(*)::int FROM workspace_credentials WHERE scope<>'project' AND metadata->>'agent_project_id'=$1) AS shared_credentials,
      (SELECT COUNT(*)::int FROM workspace_credentials WHERE metadata->>'agent_project_id'=$1 AND (metadata->>'ownership') IS NULL) AS review_credentials
  `, [projectId]);

  const blockers: string[] = [];
  if (project.lifecycle_status !== 'retired') blockers.push('ACTIVE_AGENT_MUST_BE_RETIRED_FIRST');
  const dedicated = Number(counts?.dedicated_credentials ?? 0);
  const shared = Number(counts?.shared_credentials ?? 0);
  const reviewRequired = Number(counts?.review_credentials ?? 0);
  if (shared > 0) blockers.push('SHARED_CREDENTIAL_REFERENCE');
  if (reviewRequired > 0) blockers.push('CREDENTIAL_OWNERSHIP_REVIEW_REQUIRED');

  const impact: AgentPurgeImpact = {
    projectId, projectName: project.name, lifecycleStatus: project.lifecycle_status,
    rootPath: project.root_path ?? null, folder: measureDirectory(project.root_path ?? null),
    database: {
      sessions: Number(counts?.sessions ?? 0), messages: Number(counts?.messages ?? 0),
      projectMembers: Number(counts?.project_members ?? 0), runtimeBoxes: Number(counts?.runtime_boxes ?? 0),
      agentWorkers: Number(counts?.agent_workers ?? 0), agentEvents: Number(counts?.agent_events ?? 0),
      aiServices: Number(counts?.ai_services ?? 0),
    },
    credentials: { dedicated, shared, reviewRequired }, blockers,
    warnings: ['This preview performs no deletion.', 'Shared resources are protected and block permanent deletion.'],
  };
  const proposalHash = digest(impact);
  const intent = await queryOne<{ id: string; expires_at: string }>(`
    INSERT INTO agent_purge_preview_intents(project_id,actor_user_id,proposal_hash,lifecycle_status,impact_snapshot)
    VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id,expires_at
  `, [projectId, actorUserId, proposalHash, project.lifecycle_status, JSON.stringify(impact)]);
  if (!intent) throw new Error('failed to create purge preview intent');
  return { intentId: intent.id, proposalHash, expiresAt: intent.expires_at, impact, applyAvailable: false };
}
