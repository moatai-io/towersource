import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ query: vi.fn(), accessible: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ transaction: async (fn: any) => fn(db) }));
vi.mock('../pm/project-membership-manager.js', () => ({ getAccessibleProjectIds: db.accessible }));
import { getVisualTeams, patchVisualTeams, visualTeamsPatchSchema, VISUAL_TEAMS_SETTING_KEY } from './visual-teams.js';
const ta = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tb = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let state: any;
let user: any;
let projects: string[];
let target: boolean;
beforeEach(() => {
  state = { version: 2, teams: [{ id: ta, name: 'Design' }, { id: tb, name: 'Private' }], assignments: { a: ta, b: tb, retired: ta } };
  user = { role: 'admin', disabled: 0, approval_status: 'active' };
  projects = ['a', 'b']; target = true;
  db.accessible.mockReset().mockImplementation(async () => projects);
  db.query.mockReset().mockImplementation(async (sql: string, params: any[]) => {
    if (sql.includes('pg_advisory')) return { rows: [] };
    if (sql.includes('FROM users')) return { rows: user ? [user] : [] };
    if (sql.includes('SELECT value')) return { rows: state ? [{ value: state }] : [] };
    if (sql.includes('SELECT p.id')) return { rows: projects.map(id => ({ id })) };
    if (sql.includes('SELECT id FROM projects')) return { rows: target ? [{ id: params[0] }] : [] };
    if (sql.includes('INSERT INTO app_settings')) { state = JSON.parse(params[1]); return { rows: [] }; }
    throw new Error(`Unexpected query ${sql}`);
  });
});
const writes = () => db.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO app_settings'));

describe('visual team metadata', () => {
  it('returns initial version without writing or seeding authority', async () => {
    state = null;
    expect(await getVisualTeams(1)).toEqual({ version: 0, teams: [], assignments: {}, canManage: true });
    expect(writes()).toHaveLength(0);
  });
  it('returns shared groups but only canonical accessible assignments for admin', async () => {
    expect(await getVisualTeams(1)).toEqual({ version: 2, teams: state.teams, assignments: { a: ta, b: tb }, canManage: true });
    expect(writes()).toHaveLength(0);
  });
  it.each(['operator', 'member', 'viewer', 'guest'])('filters inaccessible team names for %s and denies mutation', async role => {
    user.role = role; projects = ['a'];
    expect(await getVisualTeams(2)).toEqual({ version: 2, teams: [{ id: ta, name: 'Design' }], assignments: { a: ta }, canManage: false });
    await expect(patchVisualTeams(2, { expectedVersion: 2, command: { kind: 'create', name: 'New' } })).rejects.toMatchObject({ status: 403 });
    expect(writes()).toHaveLength(0);
  });
  it.each([null, { role: 'admin', disabled: 1, approval_status: 'active' }, { role: 'admin', disabled: 0, approval_status: 'pending' }, { role: 'external', disabled: 0, approval_status: 'active' }])('rejects inactive/unsupported current account %j', async actor => {
    user = actor;
    await expect(getVisualTeams(1)).rejects.toMatchObject({ status: 403 });
    await expect(patchVisualTeams(1, { expectedVersion: 2, command: { kind: 'create', name: 'New' } })).rejects.toMatchObject({ status: 403 });
    expect(writes()).toHaveLength(0);
  });
  it('creates server UUID, normalizes name and serializes before fresh authorization/load', async () => {
    const result = await patchVisualTeams(1, { expectedVersion: 2, command: { kind: 'create', name: '  New  ' } });
    expect(result.version).toBe(3);
    expect(result.teams[2]).toMatchObject({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: 'New' });
    expect(db.query.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(db.query.mock.calls[1][0]).toContain('FOR SHARE');
    expect(writes()[0][1]).toEqual([VISUAL_TEAMS_SETTING_KEY, expect.any(String), 1]);
  });
  it('assigns/reassigns/unassigns without changing other metadata', async () => {
    let result = await patchVisualTeams(1, { expectedVersion: 2, command: { kind: 'assign', projectId: 'a', teamId: tb } });
    expect(result.assignments).toEqual({ a: tb, b: tb });
    result = await patchVisualTeams(1, { expectedVersion: 3, command: { kind: 'assign', projectId: 'b', teamId: null } });
    expect(result.assignments).toEqual({ a: tb });
    expect(result.teams).toHaveLength(2);
  });
  it('returns 409 without writing stale state', async () => {
    await expect(patchVisualTeams(1, { expectedVersion: 1, command: { kind: 'create', name: 'New' } })).rejects.toMatchObject({ status: 409 });
    expect(writes()).toHaveLength(0);
  });
  it('rejects missing/retired/archived target and nonexistent team', async () => {
    target = false;
    await expect(patchVisualTeams(1, { expectedVersion: 2, command: { kind: 'assign', projectId: 'retired', teamId: ta } })).rejects.toMatchObject({ status: 404 });
    target = true;
    await expect(patchVisualTeams(1, { expectedVersion: 2, command: { kind: 'assign', projectId: 'a', teamId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } })).rejects.toMatchObject({ status: 404 });
    expect(writes()).toHaveLength(0);
    const sql = db.query.mock.calls.find(([sql]) => sql.includes('SELECT id FROM projects'))![0];
    expect(sql).toMatch(/archived/); expect(sql).toMatch(/lifecycle_status/); expect(sql).toMatch(/FOR SHARE/);
  });
  it('fails closed on corrupt persisted state, including dangling refs', async () => {
    state.assignments.a = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await expect(getVisualTeams(1)).rejects.toMatchObject({ status: 500 });
    state = 'not-json';
    await expect(getVisualTeams(1)).rejects.toMatchObject({ status: 500 });
  });
  it('rejects duplicate names and bounded team capacity', async () => {
    await expect(patchVisualTeams(1, { expectedVersion: 2, command: { kind: 'create', name: 'design' } })).rejects.toMatchObject({ status: 400 });
    state.teams = Array.from({ length: 200 }, (_, i) => ({ id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`, name: `Group ${i}` }));
    state.assignments = {};
    await expect(patchVisualTeams(1, { expectedVersion: 2, command: { kind: 'create', name: 'New' } })).rejects.toMatchObject({ status: 400 });
    expect(writes()).toHaveLength(0);
  });
  it('uses the canonical membership helper even for administrators and operators', async () => {
    projects = ['a'];
    expect((await getVisualTeams(1)).assignments).toEqual({ a: ta });
    expect(db.accessible).toHaveBeenCalledWith(1, 'admin');
    user.role = 'operator';
    await getVisualTeams(3);
    expect(db.accessible).toHaveBeenCalledWith(3, 'operator');
  });
  it('never reads permission teams or modifies authority, sessions, credentials or Project files', async () => {
    await patchVisualTeams(1, { expectedVersion: 2, command: { kind: 'create', name: 'New' } });
    await patchVisualTeams(1, { expectedVersion: 3, command: { kind: 'assign', projectId: 'a', teamId: ta } });
    for (const [sql] of db.query.mock.calls) {
      expect(sql).not.toMatch(/agent_teams|agent_team_members|agent_workspace_grants|sessions|credential|root_path/i);
      if (/INSERT|UPDATE|DELETE/.test(sql)) expect(sql).toMatch(/INSERT INTO app_settings/);
    }
    const source = fs.readFileSync(new URL('./visual-teams.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/node:fs|team-management|team-repository|chmod|execFile|child_process/);
  });
});

describe('strict visual teams command bounds', () => {
  it.each([
    { expectedVersion: -1, command: { kind: 'create', name: 'Team' } },
    { expectedVersion: 1.5, command: { kind: 'create', name: 'Team' } },
    { expectedVersion: Number.MAX_SAFE_INTEGER, command: { kind: 'create', name: 'Team' } },
    { expectedVersion: 0, command: { kind: 'create', name: ' ' } },
    { expectedVersion: 0, command: { kind: 'create', name: 'x'.repeat(81) } },
    { expectedVersion: 0, command: { kind: 'create', name: 'a\nb' } },
    { expectedVersion: 0, command: { kind: 'create', name: 'Team', id: ta } },
    { expectedVersion: 0, command: { kind: 'assign', projectId: '__proto__', teamId: ta } },
    { expectedVersion: 0, command: { kind: 'assign', projectId: ' a ', teamId: ta } },
    { expectedVersion: 0, command: { kind: 'assign', projectId: 'a', teamId: 'bad' } },
    { expectedVersion: 0, command: { kind: 'assign', projectId: 'a', teamId: null, confirmed: true } },
    { expectedVersion: 0, command: { kind: 'create', name: 'Team' }, actorUserId: 1 },
  ])('rejects %j without database access', async body => {
    expect(visualTeamsPatchSchema.safeParse(body).success).toBe(false);
    await expect(patchVisualTeams(1, body as any)).rejects.toMatchObject({ status: 400 });
    expect(db.query).not.toHaveBeenCalled();
  });
});
