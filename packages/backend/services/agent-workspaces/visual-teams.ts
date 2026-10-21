/** Organization-shared presentation metadata. Never an ACL/team authority source. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction } from '../../db/pg-repo.js';
import type { PoolClient } from 'pg';
import { getAccessibleProjectIds } from '../pm/project-membership-manager.js';

export const VISUAL_TEAMS_SETTING_KEY = 'agent_visual_teams_v1';
const MAX_TEAMS = 200;
const projectId = z.string().min(1).max(200).refine(value => value.trim() === value && !['__proto__', 'constructor', 'prototype'].includes(value));
const teamName = z.string().trim().min(1).max(80).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
export const visualTeamsPatchSchema = z.object({
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  command: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('create'), name: teamName }).strict(),
    z.object({ kind: z.literal('assign'), projectId, teamId: z.string().uuid().nullable() }).strict(),
  ]),
}).strict();
export type VisualTeamsPatch = z.infer<typeof visualTeamsPatchSchema>;
const stateSchema = z.object({
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  teams: z.array(z.object({ id: z.string().uuid(), name: teamName }).strict()).max(MAX_TEAMS),
  assignments: z.record(projectId, z.string().uuid()).refine(value => Object.keys(value).length <= 10000),
}).strict();
type State = z.infer<typeof stateSchema>;
export type VisualTeamsSnapshot = State & { canManage: boolean };
export class VisualTeamsError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function actor(client: PoolClient, userId: number, manage: boolean) {
  const { rows: [user] } = await client.query<{ role: string; disabled: number; approval_status: string }>(
    'SELECT role, disabled, approval_status FROM users WHERE id = $1 FOR SHARE', [userId],
  );
  if (!user || user.disabled !== 0 || user.approval_status !== 'active'
    || !['admin', 'operator', 'member', 'viewer', 'guest'].includes(user.role)) {
    throw new VisualTeamsError(403, 'Active account required');
  }
  if (manage && user.role !== 'admin') throw new VisualTeamsError(403, 'Administrator required');
  return user;
}

async function load(client: PoolClient): Promise<State> {
  const { rows: [row] } = await client.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1', [VISUAL_TEAMS_SETTING_KEY]);
  if (!row) return { version: 0, teams: [], assignments: {} };
  try {
    const state = stateSchema.parse(typeof row.value === 'string' ? JSON.parse(row.value) : row.value);
    const ids = new Set(state.teams.map(team => team.id));
    if (ids.size !== state.teams.length || Object.values(state.assignments).some(id => !ids.has(id))) throw new Error('Invalid references');
    return state;
  } catch { throw new VisualTeamsError(500, 'Visual teams unavailable'); }
}

async function snapshot(userId: number, role: string, state: State): Promise<VisualTeamsSnapshot> {
  // Reuse canonical Project-list authority. Roles and ownership alone never
  // widen accessible content. This helper reads memberships; it cannot write them.
  const accessible = new Set(await getAccessibleProjectIds(userId, role));
  const assignments = Object.fromEntries(Object.entries(state.assignments).filter(([id]) => accessible.has(id)));
  const visibleTeamIds = new Set(Object.values(assignments));
  return { version: state.version, teams: role === 'admin' ? state.teams : state.teams.filter(team => visibleTeamIds.has(team.id)),
    assignments, canManage: role === 'admin' };
}

export async function getVisualTeams(userId: number): Promise<VisualTeamsSnapshot> {
  return transaction(async client => {
    const user = await actor(client, userId, false);
    return snapshot(userId, user.role, await load(client));
  });
}

export async function patchVisualTeams(userId: number, input: VisualTeamsPatch): Promise<VisualTeamsSnapshot> {
  const parsed = visualTeamsPatchSchema.safeParse(input);
  if (!parsed.success) throw new VisualTeamsError(400, 'Invalid visual team command');
  return transaction(async client => {
    // One installation-wide key, including the initially missing settings row.
    // Serializing before load implements CAS without schema changes or lost updates.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [VISUAL_TEAMS_SETTING_KEY]);
    const user = await actor(client, userId, true);
    const state = await load(client);
    if (state.version !== parsed.data.expectedVersion) throw new VisualTeamsError(409, 'Visual teams version conflict');
    const command = parsed.data.command;
    if (command.kind === 'create') {
      if (state.teams.length >= MAX_TEAMS) throw new VisualTeamsError(400, 'Visual team limit reached');
      if (state.teams.some(team => team.name.toLocaleLowerCase() === command.name.toLocaleLowerCase())) {
        throw new VisualTeamsError(400, 'Visual team name already exists');
      }
      state.teams.push({ id: randomUUID(), name: command.name });
    } else {
      const { rows: [project] } = await client.query<{ id: string }>(`
        SELECT id FROM projects WHERE id = $1 AND COALESCE(archived, 0) = 0
          AND COALESCE(lifecycle_status, 'active') = 'active' FOR SHARE
      `, [command.projectId]);
      if (!project) throw new VisualTeamsError(404, 'Active project not found');
      if (command.teamId !== null && !state.teams.some(team => team.id === command.teamId)) {
        throw new VisualTeamsError(404, 'Visual team not found');
      }
      if (command.teamId === null) delete state.assignments[command.projectId];
      else {
        if (!Object.hasOwn(state.assignments, command.projectId) && Object.keys(state.assignments).length >= 10000) {
          throw new VisualTeamsError(400, 'Visual assignment limit reached');
        }
        state.assignments[command.projectId] = command.teamId;
      }
    }
    state.version++;
    await client.query(`
      INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
    `, [VISUAL_TEAMS_SETTING_KEY, JSON.stringify(state), userId]);
    return snapshot(userId, user.role, state);
  });
}
