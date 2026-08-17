import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(import.meta.dirname, '../../db/migrations/124_legacy_channel_agent_backfill.sql'), 'utf8');
const manager = fs.readFileSync(path.resolve(import.meta.dirname, 'room-manager.ts'), 'utf8');

describe('legacy channel Agent membership backfill', () => {
  it('adds only explicit active or ready Primary Agents from historical Project origins', () => {
    expect(migration).toContain('JOIN project_agent_profiles pap');
    expect(migration).toContain("pap.status IN ('active', 'ready')");
    expect(migration).toContain('cr.legacy_origin_project_id');
  });

  it('is idempotent and restores a previously revoked matching membership', () => {
    expect(migration).toContain('ON CONFLICT (channel_id, agent_project_id)');
    expect(migration).toContain('DO UPDATE SET revoked_at = NULL');
  });

  it('returns current invited Agent names with room list responses', () => {
    expect(manager).toContain('AS invited_agent_names');
    expect(manager).toContain('channel_agent_memberships cam');
  });
});
