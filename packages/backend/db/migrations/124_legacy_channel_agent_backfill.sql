-- Give legacy Project-origin channels a concrete current identity: when the
-- origin Project has an active/ready Primary Agent profile, invite that Agent.
-- Idempotent and reversible through normal channel Agent removal.
INSERT INTO channel_agent_memberships (
  channel_id, agent_project_id, invited_by, created_at, revoked_at
)
SELECT cr.id,
       cr.legacy_origin_project_id,
       cr.created_by,
       NOW(),
       NULL
  FROM chat_rooms cr
  JOIN project_agent_profiles pap ON pap.project_id = cr.legacy_origin_project_id
 WHERE cr.legacy_origin_project_id IS NOT NULL
   AND pap.status IN ('active', 'ready')
ON CONFLICT (channel_id, agent_project_id)
DO UPDATE SET revoked_at = NULL;

COMMENT ON TABLE channel_agent_memberships IS
  'Primary Agents invited to a channel. Invitation grants discovery/invocation only; channel resource links and connector policy define data authority.';
