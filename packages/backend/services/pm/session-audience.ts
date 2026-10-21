/** Shared SQL audience for transcript reads, search and pre-LIMIT listing. */
export function administratorParticipationSql(scope: 'project' | 'channel', target: string, actor: string): string {
  const column = scope === 'project' ? 'project_id' : 'room_id';
  return `EXISTS (SELECT 1 FROM administrator_participations ap
    JOIN users au ON au.id = ap.user_id AND au.role = 'operator' AND au.disabled = 0
    WHERE ap.${column} = ${target} AND ap.user_id = ${actor} AND ap.left_at IS NULL)`;
}

/** Active admins are exempt from Project membership, independently of email enrollment. */
export function activeAdminSql(actor: string): string {
  return `EXISTS (SELECT 1 FROM users legacy_admin WHERE legacy_admin.id = ${actor}
    AND legacy_admin.role = 'admin' AND legacy_admin.disabled = 0)`;
}

/** Mandatory current-use prerequisite for ALL team Session readers, not an audience grant.
 * Team revocation blocks surviving Project/share grants. Teamless retains legacy policy.
 * For team Agents this mirrors current repository account/Agent/team facts.
 * Channels require both room and execution label. Schema errors propagate.
 */
export function currentTeamSessionUseSql(alias: string, actor: string): string {
  return `(CASE
    WHEN ${alias}.project_id IS NULL THEN TRUE
    WHEN ${alias}.room_id IS NOT NULL AND ${alias}.label IN ('channel_agent', 'channel_ai') THEN TRUE
    ELSE EXISTS (SELECT 1 FROM users team_actor
      JOIN projects team_agent ON team_agent.id = ${alias}.project_id
      WHERE team_actor.id = ${actor} AND team_actor.disabled = 0 AND team_actor.approval_status = 'active'
        AND team_agent.archived = 0 AND team_agent.lifecycle_status = 'active'
        AND (NOT EXISTS (SELECT 1 FROM agent_team_projects team_link WHERE team_link.project_id = team_agent.id)
          OR (team_actor.role IN ('admin', 'operator', 'member')
            AND EXISTS (SELECT 1 FROM project_agent_profiles team_profile
              WHERE team_profile.project_id = team_agent.id AND team_profile.status IN ('active', 'ready'))
            AND EXISTS (SELECT 1 FROM agent_team_projects team_link
              JOIN agent_teams current_team ON current_team.id = team_link.team_id AND current_team.state = 'active'
              JOIN agent_team_members current_member ON current_member.team_id = current_team.id
                AND current_member.user_id = team_actor.id AND current_member.state = 'active'
              WHERE team_link.project_id = team_agent.id))))
    END)`;
}

export function sessionAudienceSql(alias: string, actor: string): string {
  const s = alias;
  const legacy = `((${s}.project_id IS NULL
    OR (${s}.room_id IS NOT NULL AND ${s}.label IN ('channel_agent', 'channel_ai'))
    OR ${activeAdminSql(actor)}
    OR EXISTS (SELECT 1 FROM project_members scope_pm WHERE scope_pm.project_id = ${s}.project_id AND scope_pm.user_id = ${actor}))
    AND (${s}.user_id = ${actor} OR CASE
    WHEN ${s}.visibility = 'private' THEN FALSE
    WHEN ${s}.room_id IS NOT NULL AND ${s}.label IN ('channel_agent', 'channel_ai') THEN
      EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = ${s}.room_id AND rm.user_id = ${actor})
    ELSE
      (${s}.project_id IS NOT NULL AND ${s}.visibility = 'project'
        AND (${activeAdminSql(actor)} OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = ${s}.project_id AND pm.user_id = ${actor})))
    END))`;
  // Rollout guard only: off emits identical legacy SQL without team tables.
  // Enabled requires current use AND (legacy audience OR extra owner admission).
  // Never preserve legacy rights around this gate or expand projectMember.
  if (process.env.TOWER_TEAM_WORKSPACES_ENABLED !== '1') return legacy;
  return `(${currentTeamSessionUseSql(s, actor)} AND (${legacy}
    OR (${s}.user_id = ${actor}
      AND EXISTS (SELECT 1 FROM agent_team_projects owner_team WHERE owner_team.project_id = ${s}.project_id))))`;
}

/** Compatibility helper: metadata cannot grant access beyond the content audience. */
export function companySessionMetadataSql(alias: string, actor: string): string {
  return sessionAudienceSql(alias, actor);
}

/** Whitelist only: SessionMeta contains many transcript-derived and internal fields. */
export function redactCompanySessionMetadata<T extends object>(session: T): T {
  const row = session as Record<string, unknown>;
  return Object.fromEntries([
    'id', 'shortCode', 'name', 'projectId', 'visibility', 'ownerUsername', 'createdAt', 'updatedAt',
  ].filter(key => key in row).map(key => [key, row[key]])) as T;
}
