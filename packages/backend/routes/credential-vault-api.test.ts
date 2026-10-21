import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db/pg-repo.js', () => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock('../services/pm/project-access.js', () => ({
  isAdminOrOperator: (role: string) => ['admin', 'operator'].includes(role),
  isPrivilegedRole: (role: string) => ['admin', 'operator'].includes(role),
}));
vi.mock('../services/gateway-profile/gateway-profile-verify.js', () => ({ verifyGatewayProfile: vi.fn() }));
vi.mock('../services/credential-vault/credential-vault-service.js', () => ({
  allowedProjectCredentialWhere: () => '(mock Agent scope predicate)',
  deleteCredential: vi.fn(), copyProjectCredential: vi.fn(), listWorkspaceCredentials: vi.fn(),
  promoteProjectCredentialToWorkspace: vi.fn(), revealCredentialValue: vi.fn(), rotateExistingCredential: vi.fn(),
  updateCredentialLifecycle: vi.fn(), upsertApiKeyCredential: vi.fn(), upsertAgentGwsCredential: vi.fn(),
}));
import { execute, query } from '../db/pg-repo.js';
import { verifyGatewayProfile } from '../services/gateway-profile/gateway-profile-verify.js';
import { copyProjectCredential, listWorkspaceCredentials, promoteProjectCredentialToWorkspace, revealCredentialValue, rotateExistingCredential, upsertApiKeyCredential, upsertAgentGwsCredential, updateCredentialLifecycle, deleteCredential } from '../services/credential-vault/credential-vault-service.js';
import router from './credential-vault-api.js';

// Invoke the actual registered Express handlers with HTTP request/response shapes.
async function request(method: string, path: string, role: string | undefined = 'member', body: Record<string, unknown> = {}, projectId = 'agent-a') {
  const route = (router as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route;
  const req = { user: role ? { userId: 7, role } : undefined, body, params: { projectId, credentialId: 'synthetic-connection', apiId: 'naver' } };
  const res: any = { statusCode: 200, headers: {}, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (data: unknown) => { res.body = data; return res; };
  res.setHeader = (key: string, value: string) => { res.headers[key] = value; return res; };
  await route.stack[0].handle(req, res);
  return res;
}
const record: any = { id: 'synthetic-connection', scope: 'project', project_id: 'agent-a', secret_name: 'SYNTHETIC_STORAGE', enabled: true, metadata: {} };
const input = { id: record.id, provider: 'custom', displayName: 'Synthetic', secretName: 'SYNTHETIC_TOKEN', secretValue: 'synthetic-only' };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(query).mockResolvedValue([{ creator_user_id: 99, membership_role: 'member' }]);
  vi.mocked(execute).mockResolvedValue({ changes: 1 });
  for (const fn of [upsertApiKeyCredential, upsertAgentGwsCredential, rotateExistingCredential, updateCredentialLifecycle, promoteProjectCredentialToWorkspace, copyProjectCredential]) vi.mocked(fn).mockResolvedValue(record);
  vi.mocked(deleteCredential).mockResolvedValue(true);
  vi.mocked(listWorkspaceCredentials).mockResolvedValue([record]);
  vi.mocked(revealCredentialValue).mockResolvedValue({ credential: record, value: 'synthetic-only' });
  vi.mocked(verifyGatewayProfile).mockResolvedValue({ profileId: 'tower-shared-api-v1', status: 'ready', verified: true, httpStatus: 200, checkedApi: 'agent-store', verifiedAt: '2026-09-18T00:00:00Z' });
});

describe('Gateway Profile admin read model', () => {
  it.each(['operator', 'admin'])('returns a secret-free profile to %s', async role => {
    vi.mocked(query).mockResolvedValueOnce([{
      id: 'tower-shared-api-v1', version: 1, display_name: 'Tower Shared APIs v1', gateway_provider: 'zuplo',
      gateway_base_url: 'https://gateway.example.com', consumer_ref: 'vm-example', desired_state_hash: 'a'.repeat(64),
      applied_state_hash: 'a'.repeat(64), status: 'ready', credential_configured: true, credential_enabled: true,
      last_verified_at: '2026-09-18T00:00:00Z', last_error_code: null, metadata: {}, created_at: '2026-09-18T00:00:00Z',
      updated_at: '2026-09-18T00:00:00Z', catalog: [{ apiId: 'firecrawl', routePrefix: '/fc', readiness: 'ready' }],
    }]);
    const res = await request('get', '/admin/gateway-profile', role);
    expect(res.statusCode).toBe(200);
    expect(res.body.profiles[0]).toMatchObject({ id: 'tower-shared-api-v1', stateMatches: true, credential: { configured: true, enabled: true } });
    expect(JSON.stringify(res.body)).not.toMatch(/secret[_-]?name|api[_-]?key|credential_id/i);
  });

  it.each(['member', 'viewer', 'guest', 'unknown'])('denies %s before querying profile state', async role => {
    expect((await request('get', '/admin/gateway-profile', role)).statusCode).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('lets an operator explicitly allow or deny one API independently of readiness', async () => {
    const path = '/admin/gateway-profile/catalog/:apiId';
    expect((await request('patch', path, 'operator', { profileId: 'tower-shared-api-v1', enabled: false })).statusCode).toBe(400);
    expect((await request('patch', path, 'member', { profileId: 'tower-shared-api-v1', enabled: false, confirmed: true })).statusCode).toBe(403);
    const updated = await request('patch', path, 'operator', { profileId: 'tower-shared-api-v1', enabled: false, confirmed: true });
    expect(updated.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('SET enabled = $3'), ['tower-shared-api-v1', 'naver', false, 7]);
  });

  it('requires explicit confirmation and authorized role for bounded verification', async () => {
    expect((await request('post', '/admin/gateway-profile/verify', 'operator', {})).statusCode).toBe(400);
    expect((await request('post', '/admin/gateway-profile/verify', 'member', { confirmed: true })).statusCode).toBe(403);
    expect(verifyGatewayProfile).not.toHaveBeenCalled();
    const verified = await request('post', '/admin/gateway-profile/verify', 'operator', { confirmed: true, profileId: 'tower-shared-api-v1', apiId: 'naver' });
    expect(verified.statusCode).toBe(200);
    expect(verifyGatewayProfile).toHaveBeenCalledWith({ actorUserId: 7, profileId: 'tower-shared-api-v1', apiId: 'naver' });
    expect(JSON.stringify(verified.body)).not.toContain('synthetic-only');
  });
});

describe('company Credential management routes', () => {
  const operations = [
    ['post', '/credentials/api-key', input], ['post', '/credentials/:credentialId/rotate', { secretValue: 'synthetic-only' }],
    ['patch', '/credentials/:credentialId', { enabled: false }], ['delete', '/credentials/:credentialId', {}],
    ['post', '/credentials/:credentialId/reveal', { purpose: 'synthetic review' }],
  ] as const;
  it.each(['operator', 'admin'])('allows %s to manage company originals', async role => {
    for (const [method, path, body] of operations) expect((await request(method, path, role, body)).statusCode).toBe(200);
    expect(upsertApiKeyCredential).toHaveBeenCalledWith(expect.objectContaining({ scope: 'workspace', actorUserId: 7 }));
    expect(rotateExistingCredential).toHaveBeenCalledWith(expect.objectContaining({ scope: 'workspace' }));
  });
  it.each(['member', 'viewer', 'guest', 'unknown'])('denies %s company mutations before service call', async role => {
    for (const [method, path, body] of operations) expect((await request(method, path, role, body)).statusCode).toBe(403);
    expect(upsertApiKeyCredential).not.toHaveBeenCalled(); expect(revealCredentialValue).not.toHaveBeenCalled();
  });
  it('retains explicit confirmation on promotion', async () => {
    const path = '/admin/credentials/:credentialId/promote';
    expect((await request('post', path, 'operator', { projectId: 'agent-a' })).statusCode).toBe(400);
    expect(promoteProjectCredentialToWorkspace).not.toHaveBeenCalled();
    expect((await request('post', path, 'member', { projectId: 'agent-a', confirmed: true })).statusCode).toBe(403);
    expect((await request('post', path, 'operator', { projectId: 'agent-a', confirmed: true })).statusCode).toBe(200);
    expect(promoteProjectCredentialToWorkspace).toHaveBeenCalledWith({ credentialId: record.id, projectId: 'agent-a', actorUserId: 7 });
  });
});

describe('Agent Credential management routes', () => {
  it('lets a writable member create and reveal, while normal outputs stay secret-free', async () => {
    const created = await request('post', '/projects/:projectId/credentials/api-key', 'member', input);
    expect(created.statusCode).toBe(200); expect(created.body.credential.secret_name).toBeUndefined();
    expect(JSON.stringify(created.body)).not.toContain('synthetic-only');
    const revealed = await request('post', '/projects/:projectId/credentials/:credentialId/reveal', 'member', { purpose: 'review' });
    expect(revealed.statusCode).toBe(200); expect(revealed.headers['Cache-Control']).toBe('no-store, private');
    expect(revealCredentialValue).toHaveBeenCalledWith({ projectId: 'agent-a', credentialId: record.id, actorUserId: 7, purpose: 'review' });
  });
  it('lets a writable member register validated Google credential JSON without returning it', async () => {
    const body = { id: 'google-agent', displayName: 'Agent Google', credentialJson: JSON.stringify({ type: 'authorized_user', client_id: 'client', client_secret: 'sensitive-client-secret', refresh_token: 'sensitive-refresh' }) };
    const created = await request('post', '/projects/:projectId/credentials/google-json', 'member', body);
    expect(created.statusCode).toBe(200);
    expect(upsertAgentGwsCredential).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'agent-a', credentialId: 'google-agent', credentialTypeId: 'google_authorized_user', actorUserId: 7 }));
    expect(JSON.stringify(created.body)).not.toContain('sensitive');
  });
  it.each(['viewer', 'guest', 'unknown'])('rejects %s even with writable membership', async role => {
    expect((await request('post', '/projects/:projectId/credentials/api-key', role, input)).statusCode).toBe(403);
    expect(upsertApiKeyCredential).not.toHaveBeenCalled();
  });
  it.each(['viewer', null])('rejects member with %s project membership', async membership_role => {
    vi.mocked(query).mockResolvedValue([{ creator_user_id: 99, membership_role }]);
    expect((await request('post', '/projects/:projectId/credentials/api-key', 'member', input)).statusCode).toBe(403);
    expect(upsertApiKeyCredential).not.toHaveBeenCalled();
  });
  it('does not authorize read-only source copying', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ creator_user_id: 99, membership_role: 'member' }]).mockResolvedValueOnce([{ creator_user_id: 99, membership_role: 'viewer' }]);
    const res = await request('post', '/projects/:projectId/credentials/import', 'member', { sourceProjectId: 'source', sourceCredentialId: record.id });
    expect(res.statusCode).toBe(403); expect(copyProjectCredential).not.toHaveBeenCalled();
  });
  it('returns malformed import as a validation response', async () => {
    expect((await request('post', '/projects/:projectId/credentials/import', 'member', {})).statusCode).toBe(400);
  });
  it('exposes different management capabilities for team originals and dedicated records', async () => {
    const rows = [record, { ...record, id: 'shared', scope: 'workspace', project_id: null }];
    vi.mocked(query).mockResolvedValueOnce([{ creator_user_id: 99, membership_role: 'member' }]).mockResolvedValueOnce(rows);
    const member = await request('get', '/projects/:projectId/connections/catalog');
    expect(member.body.connections.map((c: any) => [c.canDisable, c.canReveal])).toEqual([[true, true], [false, false]]);
    vi.mocked(query).mockResolvedValueOnce(rows);
    const operator = await request('get', '/projects/:projectId/connections/catalog', 'operator');
    expect(operator.body.connections.every((c: any) => c.canDisable && c.canReveal)).toBe(true);
  });
  it('rejects unauthenticated requests', async () => {
    expect((await request('post', '/projects/:projectId/credentials/api-key', '', input)).statusCode).toBe(401);
  });
});


describe('R3: Credential routes do not restore revoked creator access', () => {
  it.each(['viewer', null])('rejects historical creator with membership %s for every management entry', async membership_role => {
    vi.mocked(query).mockResolvedValue([{ creator_user_id: 7, membership_role }]);
    for (const [method, path, body] of [
      ['post', '/projects/:projectId/credentials/:credentialId/reveal', { purpose: 'review' }],
      ['post', '/projects/:projectId/credentials/:credentialId/rotate', { secretValue: 'synthetic-only' }],
      ['delete', '/projects/:projectId/credentials/:credentialId', {}],
      ['post', '/projects/:projectId/credentials/import', { sourceProjectId: 'source', sourceCredentialId: record.id }],
      ['get', '/projects/:projectId/credentials/import-candidates', {}],
    ] as const) expect((await request(method, path, 'member', body)).statusCode).toBe(403);
    expect(revealCredentialValue).not.toHaveBeenCalled(); expect(rotateExistingCredential).not.toHaveBeenCalled();
    expect(deleteCredential).not.toHaveBeenCalled(); expect(copyProjectCredential).not.toHaveBeenCalled();
  });
  it.each(['viewer', null])('rejects import from a source created by the requester but now membership %s', async membership_role => {
    vi.mocked(query).mockResolvedValueOnce([{ creator_user_id: 99, membership_role: 'member' }]).mockResolvedValueOnce([{ creator_user_id: 7, membership_role }]);
    expect((await request('post', '/projects/:projectId/credentials/import', 'member', { sourceProjectId: 'source', sourceCredentialId: record.id })).statusCode).toBe(403);
    expect(copyProjectCredential).not.toHaveBeenCalled();
  });
  it('candidate discovery requires current writable source membership, never source creator attribution', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ membership_role: 'member' }]).mockResolvedValueOnce([]);
    expect((await request('get', '/projects/:projectId/credentials/import-candidates')).statusCode).toBe(200);
    const sql = vi.mocked(query).mock.calls[1][0];
    expect(sql).not.toContain('p.user_id = $2');
    expect(sql).toContain("pm.role IN ('owner', 'admin', 'member')");
  });
});
