import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), setSecret: vi.fn(), getSecret: vi.fn(), deleteSecret: vi.fn(), manager: vi.fn(), access: vi.fn(), execution: vi.fn(), manifest: vi.fn(), validateUrl: vi.fn(), auth: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ query: m.query, queryOne: m.queryOne, execute: m.execute }));
vi.mock('../../config.js', () => ({ config: { publicUrl: 'https://tower.example.com' } }));
vi.mock('../secret/secret-store.js', () => ({ setSecret: m.setSecret, getSecretForProjectBinding: m.getSecret, deleteSecret: m.deleteSecret }));
vi.mock('./project-mcp-access.js', () => ({ assertProjectMcpManager: m.manager, assertProjectMcpAccess: m.access, assertProjectMcpExecution: m.execution }));
vi.mock('./project-mcp-manifest.js', () => ({ readManagedMcpManifest: m.manifest }));
vi.mock('./project-mcp-network.js', () => ({ assertMcpPublicUrl: m.validateUrl, projectMcpFetch: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({ auth: m.auth }));
import { startMcpOAuth, finishMcpOAuth, createProjectMcpOAuthProvider } from './project-mcp-oauth.js';
const server = { name: 'notes', type: 'streamable-http', url: 'https://provider.example.com/mcp', authType: 'oauth' };
const flow = { project_id: 'agent', server_name: 'notes', server_url: server.url, actor_user_id: 7, secret_name: 'MCP_FLOW_SYNTHETIC' };
const connection = { ...flow, secret_owner_user_id: 7, connected: true };
beforeEach(() => {
  vi.resetAllMocks();
  m.manager.mockResolvedValue({ rootPath: '/synthetic', role: 'member' });
  m.access.mockResolvedValue({ rootPath: '/synthetic', role: 'member' });
  m.execution.mockResolvedValue(undefined); m.manifest.mockResolvedValue({ servers: [server] });
  m.query.mockResolvedValue([]); m.queryOne.mockResolvedValue(undefined); m.execute.mockResolvedValue({ changes: 1 });
  m.getSecret.mockResolvedValue(JSON.stringify({ client: { client_id: 'synthetic-client' }, verifier: 'synthetic-pkce' }));
  m.auth.mockImplementation(async provider => { await provider.saveCodeVerifier('synthetic-pkce'); await provider.redirectToAuthorization(new URL('https://provider.example.com/authorize')); return 'REDIRECT'; });
});
describe('Agent-shared SDK OAuth intent', () => {
  it('stores random state hash and PKCE only in encrypted store, not API response', async () => {
    const url = await startMcpOAuth('agent', 'notes', 7);
    expect(url).toBe('https://provider.example.com/authorize');
    const intent = m.execute.mock.calls.find(([sql]) => sql.includes('INSERT INTO project_mcp_oauth_states'))!;
    expect(intent[1][0]).toMatch(/^[0-9a-f]{64}$/); expect(intent[1]).toContain(7);
    expect(intent[0]).toContain("interval '10 minutes'");
    const encryptedInput = m.setSecret.mock.calls.at(-1)![0];
    expect(encryptedInput.scope).toBe('user'); expect(encryptedInput.ownerUserId).toBe(7);
    expect(JSON.parse(encryptedInput.value).verifier).toBe('synthetic-pkce');
    const provider = m.auth.mock.calls[0][0];
    expect(provider.redirectUrl).toBe('https://tower.example.com/api/projects/agent/mcp/oauth/callback');
    expect(await provider.state()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('rechecks management before any discovery and does not transmit when access is revoked', async () => {
    m.manager.mockRejectedValue(new Error('denied'));
    await expect(startMcpOAuth('agent', 'notes', 7)).rejects.toThrow('denied'); expect(m.auth).not.toHaveBeenCalled(); expect(m.setSecret).not.toHaveBeenCalled();
  });
  it('rejects replay/expired state before reading or sending secrets', async () => {
    await expect(finishMcpOAuth('agent', 'a'.repeat(43), 'code')).rejects.toThrow('expired');
    expect(m.getSecret).not.toHaveBeenCalled(); expect(m.auth).not.toHaveBeenCalled();
    expect(m.queryOne.mock.calls[0][0]).toContain('consumed_at IS NULL');
    expect(m.queryOne.mock.calls[0][1][1]).toBe('agent');
  });
  it('rechecks actor authority after consuming callback state', async () => {
    m.queryOne.mockImplementation(async sql => sql.startsWith('UPDATE project_mcp_oauth_states') ? flow : undefined);
    m.manager.mockRejectedValue(new Error('denied'));
    await expect(finishMcpOAuth('agent', 'a'.repeat(43), 'code')).rejects.toThrow('denied');
    expect(m.auth).not.toHaveBeenCalled(); expect(m.getSecret).not.toHaveBeenCalled();
  });
  it('completes through SDK and removes PKCE before promoting shared credentials', async () => {
    m.queryOne.mockImplementation(async sql => sql.startsWith('UPDATE project_mcp_oauth_states') ? flow : undefined);
    m.auth.mockImplementation(async provider => { expect(await provider.codeVerifier()).toBe('synthetic-pkce'); await provider.saveTokens({ access_token: 'synthetic-token', token_type: 'Bearer' }); return 'AUTHORIZED'; });
    await finishMcpOAuth('agent', 'a'.repeat(43), 'code');
    expect(m.auth.mock.calls[0][1].authorizationCode).toBe('code');
    const promoted = m.execute.mock.calls.find(([sql]) => sql.includes('INSERT INTO project_mcp_connections'))!;
    expect(promoted[0]).toContain('WHERE EXISTS'); expect(promoted[1]).toContain(7);
    expect(JSON.parse(m.setSecret.mock.calls.at(-1)![0].value).verifier).toBeUndefined();
  });
  it('blocks promotion after disconnect/new intent cancels the consumed flow', async () => {
    m.queryOne.mockImplementation(async sql => sql.startsWith('UPDATE project_mcp_oauth_states') ? flow : undefined);
    m.execute.mockImplementation(async sql => ({ changes: sql.includes('INSERT INTO project_mcp_connections') ? 0 : 1 }));
    m.auth.mockImplementation(async provider => { await provider.saveTokens({ access_token: 'synthetic-token', token_type: 'Bearer' }); return 'AUTHORIZED'; });
    await expect(finishMcpOAuth('agent', 'a'.repeat(43), 'code')).rejects.toThrow('cancelled');
  });
  it('allows another Agent member to use the shared account, but rechecks revoke before tokens', async () => {
    m.queryOne.mockImplementation(async sql => sql.startsWith('SELECT value_encrypted') ? { value_encrypted: Buffer.from('synthetic-ciphertext') } : connection); m.getSecret.mockResolvedValue(JSON.stringify({ tokens: { access_token: 'synthetic-token', token_type: 'Bearer' } }));
    const provider = await createProjectMcpOAuthProvider('agent', 'notes', server.url, 8);
    expect(m.getSecret).toHaveBeenCalledWith(flow.secret_name, 7);
    expect(await provider.tokens()).toMatchObject({ access_token: 'synthetic-token' });
    m.queryOne.mockResolvedValue(undefined);
    await expect(provider.tokens()).rejects.toThrow('no longer available');
    await expect(provider.redirectToAuthorization(new URL('https://provider.example.com/authorize'))).rejects.toThrow('Reconnect');
  });
  it('fails closed when another refresh wins ciphertext compare-and-swap', async () => {
    m.queryOne.mockImplementation(async sql => sql.startsWith('SELECT value_encrypted') ? { value_encrypted: Buffer.from('synthetic-ciphertext') } : connection);
    m.getSecret.mockResolvedValue(JSON.stringify({ tokens: { access_token: 'synthetic-token', token_type: 'Bearer' } }));
    const provider = await createProjectMcpOAuthProvider('agent', 'notes', server.url, 8);
    await provider.tokens();
    m.execute.mockResolvedValue({ changes: 0 });
    await expect(provider.saveTokens({ access_token: 'synthetic-new-token', token_type: 'Bearer' })).rejects.toThrow('Concurrent');
    expect(m.execute.mock.calls.at(-1)![0]).toContain('target.value_encrypted=$3');
  });
  it('invalidates authentication status only when current ciphertext CAS succeeds', async () => {
    m.queryOne.mockImplementation(async sql => sql.startsWith('SELECT value_encrypted') ? { value_encrypted: Buffer.from('synthetic-ciphertext') } : connection);
    m.getSecret.mockResolvedValue(JSON.stringify({ tokens: { access_token: 'synthetic-token', token_type: 'Bearer' } }));
    const provider = await createProjectMcpOAuthProvider('agent', 'notes', server.url, 8);
    await provider.invalidateCredentials!('tokens');
    expect(m.execute.mock.calls.at(-1)![1].at(-1)).toBe(false);
  });
  it('does not decrypt for read-only or missing execution authority', async () => {
    m.execution.mockRejectedValue(new Error('denied'));
    await expect(createProjectMcpOAuthProvider('agent', 'notes', server.url, 8)).rejects.toThrow('denied');
    expect(m.getSecret).not.toHaveBeenCalled();
  });
});
