import { deriveAgentCareerLevel, highestAgentCareerLevel, type AgentCareerLevel, type AgentCareerMetrics } from '@tower/shared';
import { transaction } from '../../db/pg-repo.js';

const LEVELS: readonly AgentCareerLevel[] = ['intern', 'practitioner', 'manager', 'partner'];

export interface AgentCareerPromotionResult {
  projectId: string;
  from: AgentCareerLevel;
  to: AgentCareerLevel;
  metrics: AgentCareerMetrics;
  promoted: boolean;
}

/**
 * Reconcile one Primary Agent's stored career after meaningful work completes.
 * The profile row is locked so concurrent terminal turns cannot duplicate or
 * reverse a promotion. Existing Session snapshots intentionally remain pinned.
 */
export async function reconcileProjectAgentCareer(projectId: string): Promise<AgentCareerPromotionResult | null> {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) return null;

  return transaction(async (client) => {
    const profileResult = await client.query<{ career_level: AgentCareerLevel }>(
      `SELECT career_level
         FROM project_agent_profiles
        WHERE project_id=$1
        FOR UPDATE`,
      [normalizedProjectId],
    );
    const current = profileResult.rows[0]?.career_level;
    if (!current || !LEVELS.includes(current)) return null;

    const metricsResult = await client.query<{
      completed_workstreams: number | string;
      successful_skill_invocations: number | string;
    }>(
      `SELECT
         (SELECT COUNT(DISTINCT workstream_key)
            FROM work_ledger_records
           WHERE project_id=$1 AND status='completed')::int AS completed_workstreams,
         (SELECT COUNT(*)
            FROM process_events
           WHERE project_id=$1
             AND source_type='skill_invocation'
             AND event_type='step_completed')::int AS successful_skill_invocations`,
      [normalizedProjectId],
    );
    const metricRow = metricsResult.rows[0];
    const metrics: AgentCareerMetrics = {
      completedWorkstreams: Number(metricRow?.completed_workstreams) || 0,
      successfulSkillInvocations: Number(metricRow?.successful_skill_invocations) || 0,
    };
    const target = highestAgentCareerLevel(current, deriveAgentCareerLevel(metrics));
    if (target === current) return { projectId: normalizedProjectId, from: current, to: target, metrics, promoted: false };

    await client.query(
      `UPDATE project_agent_profiles
          SET career_level=$2,
              instruction_version=instruction_version+1,
              updated_at=NOW()
        WHERE project_id=$1`,
      [normalizedProjectId, target],
    );
    for (let index = LEVELS.indexOf(current) + 1; index <= LEVELS.indexOf(target); index += 1) {
      await client.query(
        `INSERT INTO project_agent_promotions(project_id,from_level,to_level,metrics,policy_version)
         VALUES($1,$2,$3,$4::jsonb,'tower-derived-v3')
         ON CONFLICT(project_id,to_level) DO NOTHING`,
        [normalizedProjectId, LEVELS[index - 1], LEVELS[index], JSON.stringify(metrics)],
      );
    }
    return { projectId: normalizedProjectId, from: current, to: target, metrics, promoted: true };
  });
}

/** Reconcile the Agent that owns a Session, if the Session belongs to a Project. */
export async function reconcileSessionProjectAgentCareer(sessionId: string): Promise<AgentCareerPromotionResult | null> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return null;
  return transaction(async (client) => {
    const result = await client.query<{ project_id: string | null }>('SELECT project_id FROM sessions WHERE id=$1', [normalizedSessionId]);
    const projectId = result.rows[0]?.project_id;
    if (!projectId) return null;
    return projectId;
  }).then((projectId) => projectId ? reconcileProjectAgentCareer(projectId) : null);
}
