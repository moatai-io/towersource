import type { PoolClient } from 'pg';
import { transaction } from '../../db/pg-repo.js';

export type TeamManagementCommand =
  | { kind: 'create'; teamId: string; name: string }
  | { kind: 'invite' | 'revoke'; teamId: string; userId: number }
  | { kind: 'assign'; teamId: string; projectId: string };
export interface TeamManagementPreview {
  actorUserId: number;
  command: TeamManagementCommand;
  expected: {
    teamVersion: number | null;
    teamState: string | null;
    memberState: string | null;
    assignedTeamId: string | null;
    workspaceIds: string[];
  };
  warnings: string[];
}

function positiveId(value: number) { return Number.isSafeInteger(value) && value > 0; }
function text(value: string, max: number) { return typeof value === 'string' && !!value.trim() && value.length <= max; }
export function validateTeamManagementInput(actorUserId: number, command: TeamManagementCommand): void {
  if (!positiveId(actorUserId) || !command || !text(command.teamId, 200)
    || (command.kind === 'create' ? !text(command.name, 200)
      : command.kind === 'assign' ? !text(command.projectId, 200)
      : command.kind === 'invite' || command.kind === 'revoke' ? !positiveId(command.userId) : true)) {
    throw new Error('TEAM_MANAGEMENT_INPUT_INVALID');
  }
}

/** Locks are retained through apply commit: actor revocation cannot race a write.
 * Team version serializes these internal commands; 236 has no member version.
 * No public route. Other future writers must participate in this locking/version contract.
 */
async function inspect(client: PoolClient, actorUserId: number, command: TeamManagementCommand): Promise<TeamManagementPreview> {
  const actor = (await client.query('SELECT id,role,disabled,approval_status FROM users WHERE id=$1 FOR SHARE', [actorUserId])).rows[0];
  if (!actor || actor.role !== 'admin' || actor.disabled !== 0 || actor.approval_status !== 'active') {
    throw new Error('TEAM_MANAGEMENT_ADMIN_REQUIRED');
  }
  // Also serializes create when no team row exists; namespace is internal to this module.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('team-management:' || $1,0))", [command.teamId]);
  const team = (await client.query('SELECT version,state FROM agent_teams WHERE id=$1 FOR UPDATE', [command.teamId])).rows[0];
  if (command.kind === 'create') {
    if (team) throw new Error('TEAM_MANAGEMENT_TEAM_EXISTS');
  } else if (!team || team.state !== 'active') throw new Error('TEAM_MANAGEMENT_TEAM_INACTIVE');

  const expected: TeamManagementPreview['expected'] = {
    teamVersion: team?.version ?? null, teamState: team?.state ?? null,
    memberState: null, assignedTeamId: null, workspaceIds: [],
  };
  const warnings: string[] = [];
  if (command.kind === 'invite' || command.kind === 'revoke') {
    const user = (await client.query('SELECT role,disabled,approval_status FROM users WHERE id=$1 FOR SHARE', [command.userId])).rows[0];
    if (!user) throw new Error('TEAM_MANAGEMENT_USER_REQUIRED');
    if (command.kind === 'invite' && (user.disabled !== 0 || user.approval_status !== 'active'
      || !['admin', 'operator', 'member'].includes(user.role))) throw new Error('TEAM_MANAGEMENT_INVITEE_INELIGIBLE');
    expected.memberState = (await client.query('SELECT state FROM agent_team_members WHERE team_id=$1 AND user_id=$2 FOR UPDATE',
      [command.teamId, command.userId])).rows[0]?.state ?? null;
    if (command.kind === 'invite') warnings.push('Invitation expands team Agent/file eligibility; it grants no Session audience or credential scope.');
  }
  if (command.kind === 'assign') {
    const project = (await client.query('SELECT archived,lifecycle_status FROM projects WHERE id=$1 FOR UPDATE', [command.projectId])).rows[0];
    const profile = (await client.query('SELECT status FROM project_agent_profiles WHERE project_id=$1 FOR SHARE', [command.projectId])).rows[0];
    if (!project || project.archived !== 0 || project.lifecycle_status !== 'active'
      || !profile || !['active', 'ready'].includes(profile.status)) throw new Error('TEAM_MANAGEMENT_AGENT_INACTIVE');
    expected.assignedTeamId = (await client.query('SELECT team_id FROM agent_team_projects WHERE project_id=$1 FOR UPDATE', [command.projectId])).rows[0]?.team_id ?? null;
    if (expected.assignedTeamId !== null && expected.assignedTeamId !== command.teamId) {
      throw new Error('TEAM_MANAGEMENT_REASSIGNMENT_REQUIRES_MIGRATION');
    }
    // Lock inactive rows too: activation must not expand the confirmed file scope before commit.
    // The Project FOR UPDATE lock also blocks FK-checked insertion of new workspace rows.
    expected.workspaceIds = (await client.query("SELECT id,state FROM agent_workspaces WHERE owner_project_id=$1 AND kind='project' ORDER BY id FOR SHARE",
      [command.projectId])).rows.filter(row => row.state === 'active').map(row => row.id);
    warnings.push('Assignment exposes existing active registered workspace files to eligible team members, including previously private file content. No files, Sessions or credentials are moved.');
  }
  return { actorUserId, command: { ...command }, expected, warnings };
}

/** Internal read-only preview. Caller must show exact command, prior facts and warnings.
 * Not a stored approval intent: confirmed may only be supplied by a trusted approval flow.
 */
export async function previewTeamManagement(input: { actorUserId: number; command: TeamManagementCommand }): Promise<TeamManagementPreview> {
  validateTeamManagementInput(input.actorUserId, input.command);
  return transaction(client => previewTeamManagementInTransaction(client, input));
}

/** Internal only: caller owns commit/rollback, including approval receipt writes. */
export async function previewTeamManagementInTransaction(
  client: PoolClient, input: { actorUserId: number; command: TeamManagementCommand },
): Promise<TeamManagementPreview> {
  validateTeamManagementInput(input.actorUserId, input.command);
  return inspect(client, input.actorUserId, input.command);
}

/** Applies only this exact preview against locked current facts. No cross-domain writes.
 * Current eligibility is rechecked; version and target state drift require a new preview.
 */
export async function applyTeamManagement(input: { actorUserId: number; preview: TeamManagementPreview; confirmed: boolean }): Promise<{ changed: boolean; teamVersion: number }> {
  validateApply(input);
  return transaction(client => applyTeamManagementInTransaction(client, input));
}

function validateApply(input: { actorUserId: number; preview: TeamManagementPreview; confirmed: boolean }): void {
  if (input.confirmed !== true) throw new Error('TEAM_MANAGEMENT_CONFIRMATION_REQUIRED');
  if (!input.preview || input.preview.actorUserId !== input.actorUserId || !input.preview.expected) throw new Error('TEAM_MANAGEMENT_INPUT_INVALID');
  validateTeamManagementInput(input.actorUserId, input.preview.command);
}

/** Internal only: raw preview is trusted server state, never public request JSON. */
export async function applyTeamManagementInTransaction(
  client: PoolClient, input: { actorUserId: number; preview: TeamManagementPreview; confirmed: boolean },
): Promise<{ changed: boolean; teamVersion: number }> {
  validateApply(input);
  const current = await inspect(client, input.actorUserId, input.preview.command);
  const before = input.preview.expected;
  const actual = current.expected;
  if (before.teamVersion !== actual.teamVersion || before.teamState !== actual.teamState
    || before.memberState !== actual.memberState || before.assignedTeamId !== actual.assignedTeamId
    || JSON.stringify(before.workspaceIds) !== JSON.stringify(actual.workspaceIds)) throw new Error('TEAM_MANAGEMENT_PREVIEW_STALE');
  const command = current.command;
  if (command.kind === 'create') {
    try {
      await client.query('INSERT INTO agent_teams (id,name) VALUES ($1,$2)', [command.teamId, command.name]);
    } catch (error) {
      // Non-participating writers may bypass our advisory lock; uniqueness still fails closed.
      if ((error as { code?: string }).code === '23505') throw new Error('TEAM_MANAGEMENT_TEAM_EXISTS');
      throw error;
    }
    return { changed: true, teamVersion: 1 };
  }
  const changed = command.kind === 'assign' ? actual.assignedTeamId === null
    : command.kind === 'invite' ? actual.memberState !== 'active' : actual.memberState === 'active';
  if (!changed) return { changed: false, teamVersion: actual.teamVersion! };
  const bumped = await client.query("UPDATE agent_teams SET version=version+1 WHERE id=$1 AND version=$2 AND state='active' RETURNING version",
    [command.teamId, before.teamVersion]);
  if (bumped.rowCount !== 1) throw new Error('TEAM_MANAGEMENT_PREVIEW_STALE');
  if (command.kind === 'assign') {
    await client.query('INSERT INTO agent_team_projects (project_id,team_id) VALUES ($1,$2)', [command.projectId, command.teamId]);
  } else if (command.kind === 'invite') {
    await client.query("INSERT INTO agent_team_members (team_id,user_id,state) VALUES ($1,$2,'active') ON CONFLICT (team_id,user_id) DO UPDATE SET state='active'", [command.teamId, command.userId]);
  } else {
    await client.query("UPDATE agent_team_members SET state='disabled' WHERE team_id=$1 AND user_id=$2", [command.teamId, command.userId]);
  }
  return { changed: true, teamVersion: bumped.rows[0].version };
}
