import { deriveAgentCareerLevel, highestAgentCareerLevel, type AgentCareerLevel, type AgentCareerMetrics } from '@tower/shared';
import { getPgPool } from '../db/pg.js';

const LEVELS: AgentCareerLevel[] = ['intern', 'practitioner', 'manager', 'partner'];
const pool = getPgPool();
const client = await pool.connect();

try {
  await client.query('BEGIN');
  const { rows } = await client.query(`
    SELECT p.id,
           p.name,
           COALESCE(pap.career_level, 'intern') AS career_level,
           COUNT(DISTINCT w.workstream_key) FILTER (WHERE w.status = 'completed')::int AS completed_workstreams,
           (SELECT COUNT(*)
              FROM process_events e
             WHERE e.project_id = p.id
               AND e.source_type = 'skill_invocation'
               AND e.event_type = 'step_completed')::int AS successful_skill_invocations
      FROM projects p
      LEFT JOIN project_agent_profiles pap ON pap.project_id = p.id
      LEFT JOIN work_ledger_records w ON w.project_id = p.id
     WHERE COALESCE(p.archived, 0) = 0
       AND pap.project_id IS NOT NULL
     GROUP BY p.id, p.name, pap.career_level
  `);

  const promoted: Array<{ name: string; from: AgentCareerLevel; to: AgentCareerLevel; metrics: AgentCareerMetrics }> = [];
  for (const row of rows) {
    const current = row.career_level as AgentCareerLevel;
    const metrics: AgentCareerMetrics = {
      completedWorkstreams: Number(row.completed_workstreams) || 0,
      successfulSkillInvocations: Number(row.successful_skill_invocations) || 0,
    };
    const target = highestAgentCareerLevel(current, deriveAgentCareerLevel(metrics));
    if (target === current) continue;

    await client.query(
      `UPDATE project_agent_profiles SET career_level=$2, updated_at=now() WHERE project_id=$1`,
      [row.id, target],
    );

    for (let index = LEVELS.indexOf(current) + 1; index <= LEVELS.indexOf(target); index += 1) {
      const toLevel = LEVELS[index];
      const fromLevel = LEVELS[index - 1];
      await client.query(
        `INSERT INTO project_agent_promotions(project_id,from_level,to_level,metrics,policy_version)
         VALUES($1,$2,$3,$4::jsonb,'tower-derived-v2')
         ON CONFLICT(project_id,to_level) DO NOTHING`,
        [row.id, fromLevel, toLevel, JSON.stringify(metrics)],
      );
    }
    promoted.push({ name: row.name, from: current, to: target, metrics });
  }

  await client.query('COMMIT');
  console.log(JSON.stringify({ promoted }, null, 2));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
