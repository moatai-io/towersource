import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { companySessionMetadataSql, currentTeamSessionUseSql, sessionAudienceSql } from './session-audience.js';

// Evaluate the shared SQL itself rather than mocking a query result. These
// predicates use portable CASE/EXISTS syntax; no live database is touched.
describe('session audience SQL: private owner-only and explicit shared audience', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', undefined);
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE sessions (id TEXT, user_id INTEGER, project_id TEXT, visibility TEXT, room_id TEXT, label TEXT);
      CREATE TABLE project_members (project_id TEXT, user_id INTEGER);
      CREATE TABLE room_members (room_id TEXT, user_id INTEGER);
      CREATE TABLE session_shares (session_id TEXT, target_user_id INTEGER, share_type TEXT, revoked INTEGER);
      CREATE TABLE administrator_participations (user_id INTEGER, project_id TEXT, room_id TEXT, left_at TEXT);
      CREATE TABLE users (id INTEGER, role TEXT, disabled INTEGER, primary_email_identity_id INTEGER);
      INSERT INTO users VALUES (10, 'operator', 0, NULL), (20, 'member', 0, NULL);
    `);
  });
  afterEach(() => { db.close(); vi.unstubAllEnvs(); });
  it('keeps off SQL identical and without team schema references', () => {
    const legacy = sessionAudienceSql('s', '$1');
    for (const value of ['0', 'true', '']) {
      vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', value);
      expect(sessionAudienceSql('s', '$1')).toBe(legacy);
    }
    expect(legacy).not.toContain('agent_team');
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
    expect(sessionAudienceSql('s', '$1')).toContain('agent_team_projects');
  });
  it('requires current team use around BOTH legacy audience and extra owner admission', () => {
    const legacy = sessionAudienceSql('s', '$1');
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
    const enabled = sessionAudienceSql('s', '$1');
    expect(enabled.startsWith(`(${currentTeamSessionUseSql('s', '$1')} AND (${legacy}`)).toBe(true);
    expect(enabled).toContain('s.user_id = $1');
    expect(enabled).toContain('owner_team.project_id = s.project_id');
    expect(enabled).toContain('team_actor.approval_status');
  });
  function insert(visibility: string | null, owner: number | null = 20, project: string | null = 'p', room: string | null = null, label = 'temp') {
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run('s', owner, project, visibility, room, label);
  }
  function visible(predicate = sessionAudienceSql('s', '10')) {
    return db.prepare(`SELECT s.id FROM sessions s WHERE ${predicate}`).all().length > 0;
  }
  it('exempts active admins independently of email enrollment', () => {
    insert('project');
    db.exec("UPDATE users SET role='admin' WHERE id=10");
    expect(visible()).toBe(true);
    db.exec("UPDATE users SET primary_email_identity_id=42 WHERE id=10");
    expect(visible()).toBe(true);
    db.exec("UPDATE users SET primary_email_identity_id=NULL, disabled=1 WHERE id=10");
    expect(visible()).toBe(false);
  });
  it('does not expose another owners private session to an admin', () => {
    insert('private');
    db.exec("UPDATE users SET role='admin' WHERE id=10");
    expect(visible()).toBe(false);
  });
  it('checks private before legacy shares, project/channel membership and automatic participation', () => {
    insert('private', 20, 'p', 'room', 'channel_ai');
    db.exec(`INSERT INTO project_members VALUES ('p', 10);
      INSERT INTO room_members VALUES ('room', 10);
      INSERT INTO session_shares VALUES ('s', 10, 'internal', 0);
      INSERT INTO administrator_participations VALUES (10, 'p', 'room', NULL);`);
    expect(visible()).toBe(false);
    expect(visible(companySessionMetadataSql('s', '10'))).toBe(false);
  });
  it.each(['private', 'project', null])('requires current membership even for the owner with visibility=%s', (visibility) => {
    insert(visibility, 10);
    expect(visible()).toBe(false);
    db.exec("INSERT INTO project_members VALUES ('p', 10)");
    expect(visible()).toBe(true);
  });
  it.each([null, 'private'])('does not auto-publish ownerless legacy visibility=%s', (visibility) => {
    insert(visibility, null);
    db.exec("INSERT INTO project_members VALUES ('p', 10)");
    expect(visible()).toBe(false);
    expect(visible(companySessionMetadataSql('s', '10'))).toBe(false);
  });
  it('allows explicit project audience only for members, not administrator participation', () => {
    insert('project');
    db.exec("INSERT INTO administrator_participations VALUES (10, 'p', NULL, NULL)");
    expect(visible()).toBe(false);
    db.exec("INSERT INTO project_members VALUES ('p', 10)");
    expect(visible()).toBe(true);
  });
  it('allows a channel audience only for channel members, not project members or administrator participation', () => {
    insert('project', null, 'p', 'room', 'channel_ai');
    db.exec(`INSERT INTO project_members VALUES ('p', 10);
      INSERT INTO administrator_participations VALUES (10, 'p', 'room', NULL);`);
    expect(visible()).toBe(false);
    db.exec("INSERT INTO room_members VALUES ('room', 10)");
    expect(visible()).toBe(true);
  });
  it.each([null, 'p'])('does not grant access via legacy internal shares for project=%s', (project) => {
    insert('project', 20, project);
    expect(visible()).toBe(false);
    db.exec("INSERT INTO session_shares VALUES ('s', 10, 'internal', 0)");
    expect(visible()).toBe(false);
    expect(visible(companySessionMetadataSql('s', '10'))).toBe(false);
    if (project) {
      db.exec("INSERT INTO project_members VALUES ('p', 10)");
      expect(visible()).toBe(true);
    }
  });
  it('requires the ordinary audience even for metadata-only company access', () => {
    insert(null, null);
    expect(visible(companySessionMetadataSql('s', '10'))).toBe(false);
    db.exec("UPDATE sessions SET visibility = 'project'");
    expect(visible(companySessionMetadataSql('s', '10'))).toBe(false);
    db.exec("INSERT INTO project_members VALUES ('p', 10)");
    expect(visible(companySessionMetadataSql('s', '10'))).toBe(true);
    expect(companySessionMetadataSql('s', '10')).toBe(sessionAudienceSql('s', '10'));
  });
});
