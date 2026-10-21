import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../../scripts/fleet/fleet-nix-remote', import.meta.url), 'utf8');
const probe = source.split('  authenticated-smoke)')[1].split('  backup-db)')[0];
describe('Fleet authenticated smoke visibility contract', () => {
  it('uses the running artifact audience, including operator metadata rather than admin bypass', () => {
    expect(probe).toContain('/cmdline');
    expect(probe).toContain('services/pm/session-audience.js');
    expect(probe).toContain("role === 'admin' ? '$1::int IS NOT NULL' : sessionAudienceSql('s', '$1')");
    expect(probe).toContain("role === 'operator' ? companySessionMetadataSql('s', '$1') : 'FALSE'");
  });
  it('filters archived sessions and sidebar rows, not retired projects', () => {
    const sql = probe.split('SELECT s.id FROM sessions s')[1].split('[Number(uid)]')[0];
    expect(sql).toContain('COALESCE(s.archived,0)=0');
    expect(sql).toContain("s.parent_session_id IS NULL OR s.label IN ('spawned','agent','conversation_branch')");
    expect(sql).toContain("s.room_id IS NULL OR s.label='channel_ai'");
    expect(sql).not.toContain('lifecycle_status');
    expect(sql).not.toContain('p.archived');
  });
  it('compares exact IDs and retries only when expected visibility changed', () => {
    expect(probe).toContain('if (!equal(before, after)) continue');
    expect(probe).toContain('/api/sessions?limit=1000');
    expect(probe).toContain('if (!equal(actual, after)) throw');
    expect(probe).toContain('attempt < 3');
    expect(probe).toContain('verification inconclusive');
    expect(probe).not.toContain('ownedSessions');
  });
});
