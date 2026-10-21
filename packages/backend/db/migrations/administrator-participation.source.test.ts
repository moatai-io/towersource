import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(new URL('./194_administrator_participation.sql', import.meta.url), 'utf8');
describe('administrator participation additive migration', () => {
  it('does not create ordinary membership grants', () => {
    expect(sql).toContain('CREATE TABLE administrator_participations');
    expect(sql).not.toMatch(/INSERT INTO (project_members|room_members)/);
    expect(sql).toContain('CREATE UNIQUE INDEX administrator_participation_project');
    expect(sql).toContain('CREATE UNIQUE INDEX administrator_participation_room');
  });
  it('revokes on downgrade/disable in the role-change transaction so re-promotion cannot revive grants', () => {
    expect(sql).toContain("NEW.role <> 'operator' OR NEW.disabled <> 0");
    expect(sql).toContain('AFTER UPDATE OF role, disabled ON users');
    expect(sql).toContain("SELECT id, NEW.id, project_id, room_id, 'role_revoked' FROM revoked");
  });
  it('makes security history append-only and independent of target deletion', () => {
    const eventDdl = sql.slice(sql.indexOf('CREATE TABLE administrator_participation_events'), sql.indexOf('CREATE INDEX administrator_participation_events_target'));
    expect(eventDdl).not.toContain('REFERENCES');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON administrator_participation_events');
  });
});
