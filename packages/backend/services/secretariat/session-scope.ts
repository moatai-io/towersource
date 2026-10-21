// Participation is narrower than administrator read access. Username comes from
// server-authored message attribution; mere membership or viewing never counts.
export const participatedSessionSql = (userParam: string) => `(s.user_id = ${userParam} OR EXISTS (
  SELECT 1 FROM messages authored JOIN users actor ON actor.id = ${userParam}
  WHERE authored.session_id = s.id AND authored.role = 'user'
    AND authored.username = actor.username AND authored.parent_tool_use_id IS NULL
    AND COALESCE(authored.metadata->>'origin', '') NOT IN ('agent-initial-interview','agent','automation')
))`;
export const sessionCandidatesSql = `SELECT s.id, s.id AS session_id, s.project_id, s.name AS run_title,
  'Recent participating conversation' AS outcome, recent.last_at AS updated_at,
  s.id || ':' || recent.last_at::text AS source_key
  FROM sessions s JOIN projects p ON p.id = s.project_id
  JOIN LATERAL (SELECT MAX(m.created_at) AS last_at FROM messages m
    WHERE m.session_id = s.id AND m.role IN ('user','assistant') AND m.parent_tool_use_id IS NULL
      AND COALESCE(m.metadata->>'contextState','active') = 'active') recent ON recent.last_at IS NOT NULL
  WHERE ${participatedSessionSql('$1')}
    AND COALESCE(s.archived,0) = 0 AND COALESCE(p.archived,0) = 0
    AND s.parent_session_id IS NULL
    AND COALESCE(s.label,'') NOT IN ('personal_secretary','worker','support','agent_worker','automation','scheduled')
    AND NOT EXISTS (SELECT 1 FROM agent_workers aw WHERE aw.backing_session_id = s.id)
    AND COALESCE(p.lifecycle_status,'active') = 'active'
    AND (s.user_id = $1 OR s.visibility = 'project' OR (s.room_id IS NOT NULL AND s.label IN ('channel_agent','channel_ai')))
    AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = s.project_id AND pm.user_id = $1)
    AND NOT EXISTS (SELECT 1 FROM secretariat_proposals sp WHERE sp.user_id=$1 AND sp.source_key=s.id || ':' || recent.last_at::text)
  ORDER BY recent.last_at DESC, s.id DESC LIMIT 10`;
