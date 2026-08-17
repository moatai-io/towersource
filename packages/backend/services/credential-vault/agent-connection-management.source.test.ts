import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const route = readFileSync(new URL('../../routes/credential-vault-api.ts', import.meta.url), 'utf8');

describe('Agent Connection management route contract', () => {
  it('centralizes project-scoped Connection manager authorization', () => {
    expect(route).toContain('async function assertProjectConnectionManager');
    expect(route).toContain("if (isPrivilegedRole(role)) return { ok: true, userId }");
    expect(route).toContain("role === 'viewer' || role === 'guest'");
    expect(route).toContain("['owner', 'admin', 'member'].includes(membershipRole ?? '')");
    expect(route).toContain('Number(rows[0].creator_user_id) === userId');
  });

  it('uses Agent manager authorization for project Connection binding changes', () => {
    expect(route).toContain("router.put('/connections/:connectionId/projects/:projectId'");
    expect(route).toContain('const allowed = await assertProjectConnectionManager(req, projectId)');
    expect(route).not.toContain("router.put('/connections/:connectionId/projects/:projectId', async (req, res) => {\n  const allowed = assertAdmin(req)");
  });

  it('offers a secret-free Organization Connection catalog for Agent managers', () => {
    expect(route).toContain("router.get('/projects/:projectId/connections/catalog'");
    expect(route).toContain('const allowed = await assertProjectConnectionManager(req, projectId)');
    expect(route).toContain("c.enabled = true AND c.scope = 'workspace'");
    expect(route).toContain("wc.scope IN ('personal', 'internal-default')");
    expect(route).not.toContain('connections/catalog/secrets');
  });

  it('uses manager authorization and stored preview intents for connect/disconnect', () => {
    expect(route).toContain("router.post('/connections/:connectionId/preview'");
    expect(route).toContain("router.post('/connections/:connectionId/apply'");
    expect(route).toContain('credential_connection_change_intents');
    expect(route).toContain('proposal_hash = $4');
    expect(route).toContain("status = 'previewed' AND consumed_at IS NULL AND expires_at > now()");
    expect(route).toContain('const allowed = await assertProjectConnectionManager(req, intent.project_id)');
    expect(route).toContain("scope IN ('workspace', 'internal-default')");
    expect(route).toContain("WHERE wc.scope = 'personal'");
    expect(route).not.toContain("scope IN ('workspace', 'internal-default', 'personal')");
  });

  it('does not widen workspace defaults or raw secret administration', () => {
    expect(route).toContain("router.put('/connection-defaults/:connectionId', async (req, res) => {\n  const allowed = assertAdmin(req)");
    expect(route).toContain("router.post('/credentials/:credentialId/reveal', async (req, res) => {\n  const allowed = assertAdmin(req)");
  });
});
