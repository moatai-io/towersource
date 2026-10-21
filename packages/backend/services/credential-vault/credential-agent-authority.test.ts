import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), transaction: vi.fn(), withClient: vi.fn() }));
vi.mock('../secret/secret-store.js', () => ({ getSecretForProjectBinding: vi.fn(), getSecret: vi.fn(), setSecret: vi.fn() }));
import { query, queryOne, execute, transaction, withClient } from '../../db/pg-repo.js';
import { getSecret, getSecretForProjectBinding, setSecret } from '../secret/secret-store.js';
import { assertCredentialManagementAccess } from './credential-management-access.js';
import { copyProjectCredential, revealCredentialValue, resolveRuntimeBoxApiKeyEnv, resolveProjectApiKeySecretValue, resolveProjectCredentialSecretValue, upsertApiKeyCredential, rotateExistingCredential, upsertOrganizationGwsCredential, upsertAgentGwsCredential, deleteCredential } from './credential-vault-service.js';

const record = { id: 'test-connection', credential_id: 'test-connection', provider: 'custom', kind: 'api_key', secret_name: 'SYNTHETIC_VAULT', default_env_name: 'SYNTHETIC_TOKEN', env_name: 'SYNTHETIC_TOKEN', scope: 'project', project_id: 'agent-a', metadata: {}, enabled: true };
let creatorUserId: number;
let role: string;
let membership: string | null;
let active: boolean;
let credential: typeof record | null;
let alias: boolean;
beforeEach(() => {
  vi.resetAllMocks(); creatorUserId = 99; role = 'member'; membership = 'member'; active = true; credential = { ...record }; alias = false;
  vi.mocked(queryOne).mockImplementation(async (sql) => {
    if (sql.includes('FROM users')) return active ? { role } : null;
    if (sql.includes('FROM projects p')) return { creator_user_id: creatorUserId, membership_role: membership };
    if (sql.includes('id <> $2')) return alias ? { id: 'another-agent' } : null;
    if (sql.startsWith('INSERT INTO workspace_credentials')) return { ...record };
    if (sql.startsWith('UPDATE workspace_credentials')) return { ...record };
    return credential;
  });
  vi.mocked(query).mockResolvedValue([record]);
  vi.mocked(getSecretForProjectBinding).mockResolvedValue('synthetic-agent-value');
  vi.mocked(getSecret).mockResolvedValue('synthetic-personal-value');
});

describe('Credential management entry uses fresh account and actual connection scope', () => {
  it.each(['member', 'operator', 'admin'])('allows %s to manage a writable Agent', async (r) => {
    role = r;
    await expect(assertCredentialManagementAccess({ actorUserId: 7, scope: 'project', projectId: 'agent-a', action: 'reveal' })).resolves.toBeUndefined();
  });
  it.each(['viewer', 'guest', 'unknown'])('denies %s despite writable membership', async (r) => {
    role = r;
    await expect(assertCredentialManagementAccess({ actorUserId: 7, scope: 'project', projectId: 'agent-a' })).rejects.toThrow('denied');
  });
  it.each(['viewer', null])('does not turn read-only/missing membership %s into write authority', async (m) => {
    membership = m;
    await expect(assertCredentialManagementAccess({ actorUserId: 7, scope: 'project', projectId: 'agent-a' })).rejects.toThrow('denied');
  });
  it('rejects an inactive account even when its previous role was admin', async () => {
    role = 'admin'; active = false;
    await expect(assertCredentialManagementAccess({ actorUserId: 7, scope: 'workspace' })).rejects.toThrow('denied');
  });
  it('requires company manager for a shared original, independent of Agent use', async () => {
    await expect(assertCredentialManagementAccess({ actorUserId: 7, scope: 'workspace', action: 'reveal' })).rejects.toThrow('denied');
    role = 'operator';
    await expect(assertCredentialManagementAccess({ actorUserId: 7, scope: 'workspace', action: 'reveal' })).resolves.toBeUndefined();
  });
  it('rejects personal or unknown runtime scopes instead of silently sharing them', async () => {
    role = 'admin';
    await expect(assertCredentialManagementAccess({ actorUserId: 7, scope: 'personal' as any })).rejects.toThrow('denied');
  });
});

describe('Agent secret identity never inherits requester personal secrets', () => {
  it.each([7, 8, 9])('uses only the binding for requester %s', async (userId) => {
    const env = await resolveRuntimeBoxApiKeyEnv({ projectId: 'agent-a', userId });
    const direct = await resolveProjectApiKeySecretValue({ projectId: 'agent-a', userId, envName: 'SYNTHETIC_TOKEN', targetType: 'test' });
    const byId = await resolveProjectCredentialSecretValue({ projectId: 'agent-a', userId, credentialId: record.id, targetType: 'test' });
    expect(env.env.SYNTHETIC_TOKEN).toBe('synthetic-agent-value');
    expect(direct?.value).toBe('synthetic-agent-value');
    expect(byId?.value).toBe('synthetic-agent-value');
    expect(getSecret).not.toHaveBeenCalled();
    expect(vi.mocked(getSecretForProjectBinding).mock.calls).toEqual([[record.secret_name], [record.secret_name], [record.secret_name]]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("AND NOT (COALESCE(c.metadata, '{}'::jsonb) ? 'legacy_personal_owner_user_id')"), ['agent-a', 'api_key']);
    expect(vi.mocked(execute).mock.calls.every(([, params]) => params?.[3] === userId)).toBe(true);
  });
  it('does not fall back to personal identity if the binding is unavailable', async () => {
    vi.mocked(getSecretForProjectBinding).mockRejectedValue(new Error('synthetic-only'));
    expect((await resolveRuntimeBoxApiKeyEnv({ projectId: 'agent-a', userId: 7 })).env).toEqual({});
    expect(getSecret).not.toHaveBeenCalled();
  });
  it('does not materialize env values when required audit fails', async () => {
    vi.mocked(execute).mockRejectedValue(new Error('audit unavailable'));
    expect((await resolveRuntimeBoxApiKeyEnv({ projectId: 'agent-a', userId: 7 })).env).toEqual({});
  });
});

describe('Explicit reveal and import remain management operations', () => {
  const reveal = () => revealCredentialValue({ projectId: 'agent-a', actorUserId: 7, credentialId: record.id, purpose: 'synthetic review' });
  it('returns an authorized value only after audit succeeds', async () => {
    expect((await reveal()).value).toBe('synthetic-agent-value');
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('credential_audit_events'), expect.arrayContaining(['credential_revealed', 7]));
    expect(JSON.stringify(vi.mocked(execute).mock.calls)).not.toContain('synthetic-agent-value');
    vi.mocked(execute).mockRejectedValue(new Error('audit unavailable'));
    await expect(reveal()).rejects.toThrow('audit unavailable');
  });
  it('denies shared-value reveal to a member but allows company manager', async () => {
    credential = { ...record, scope: 'workspace', project_id: null as any };
    await expect(reveal()).rejects.toThrow('denied');
    expect(getSecretForProjectBinding).not.toHaveBeenCalled();
    role = 'operator';
    await expect(reveal()).resolves.toHaveProperty('value', 'synthetic-agent-value');
  });
  it('denies stale/revoked project access without decrypting', async () => {
    membership = null;
    await expect(reveal()).rejects.toThrow('denied');
    expect(getSecretForProjectBinding).not.toHaveBeenCalled();
  });
  it('requires source management, not merely read-only sharing, to copy a secret', async () => {
    membership = 'viewer';
    await expect(copyProjectCredential({ sourceProjectId: 'agent-a', targetProjectId: 'agent-b', sourceCredentialId: record.id, actorUserId: 7 })).rejects.toThrow('denied');
    expect(setSecret).not.toHaveBeenCalled(); expect(getSecretForProjectBinding).not.toHaveBeenCalled();
  });
});

describe('Member storage writes cannot overwrite another global Secret Store name', () => {
  it('allocates a server-owned identity rather than using the submitted storage name', async () => {
    credential = null;
    await upsertApiKeyCredential({ id: 'new-connection', provider: 'custom', displayName: 'Synthetic', secretName: 'PLATFORM_KEY', secretValue: 'synthetic-value', scope: 'project', projectId: 'agent-a', actorUserId: 7 });
    expect(setSecret).toHaveBeenCalledWith(expect.objectContaining({ name: expect.stringMatching(/^VAULT_[A-F0-9]{56}$/), scope: 'global' }));
    expect(vi.mocked(setSecret).mock.calls[0][0].name).not.toBe('PLATFORM_KEY');
  });
  it('requires explicit migration before rotating a legacy aliased secret', async () => {
    alias = true;
    await expect(rotateExistingCredential({ credentialId: record.id, secretValue: 'synthetic-value', actorUserId: 7 })).rejects.toThrow('migration');
    expect(setSecret).not.toHaveBeenCalled();
  });
});


describe('legacy personal Credential provenance requires explicit re-registration', () => {
  beforeEach(() => { role = 'operator'; credential = { ...record, metadata: { legacy_personal_owner_user_id: 42, scope_migrated_by: 'migration_192' } }; });
  it('refuses reveal and copying even if an older caller returns a quarantined record', async () => {
    await expect(revealCredentialValue({ projectId: 'agent-a', actorUserId: 7, credentialId: record.id, purpose: 'review' })).rejects.toThrow('re-registration');
    await expect(copyProjectCredential({ sourceProjectId: 'agent-a', targetProjectId: 'agent-b', sourceCredentialId: record.id, actorUserId: 7 })).rejects.toThrow('re-registration');
    expect(getSecretForProjectBinding).not.toHaveBeenCalled();
  });
  it('never materializes a legacy personal record even if returned by a stale data adapter', async () => {
    vi.mocked(query).mockResolvedValue([credential!]);
    expect((await resolveRuntimeBoxApiKeyEnv({ projectId: 'agent-a', userId: 7 })).env).toEqual({});
    await expect(resolveProjectCredentialSecretValue({ projectId: 'agent-a', userId: 7, credentialId: record.id, targetType: 'test' })).rejects.toThrow('re-registration');
    expect(getSecretForProjectBinding).not.toHaveBeenCalled();
  });
  it('re-registers through an explicit secret replacement without touching the legacy storage identity', async () => {
    await expect(rotateExistingCredential({ credentialId: record.id, secretValue: 'synthetic-only', actorUserId: 7 })).resolves.toBeDefined();
    await expect(upsertApiKeyCredential({ id: record.id, provider: 'custom', displayName: 'Synthetic', secretName: 'SYNTHETIC_VAULT', defaultEnvName: 'SYNTHETIC_TOKEN', secretValue: 'synthetic-only', scope: 'project', projectId: 'agent-a', actorUserId: 7, metadata: {} })).resolves.toBeDefined();
    expect(setSecret).toHaveBeenCalled();
  });
});


describe('Google OAuth Credential storage revalidates current company/Agent managers', () => {
  const oauth = { credentialId: 'synthetic-google', displayName: 'Synthetic Google', secretName: 'GWS_SYNTHETIC_CONFIG', encodedConfig: 'synthetic-config', googleAccount: 'agent@example.com', actorUserId: 7 };
  beforeEach(() => { credential = null; });
  it.each(['operator', 'admin'])('accepts current %s for organization OAuth storage', async current => {
    role = current;
    await upsertOrganizationGwsCredential(oauth);
    expect(setSecret).toHaveBeenCalledWith(expect.objectContaining({ scope: 'global', value: 'synthetic-config', createdBy: 7 }));
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining("SET kind = 'gws'"), expect.any(Array));
  });
  it.each(['member', 'viewer', 'guest'])('rejects current %s for organization OAuth storage before Secret Store write', async current => {
    role = current;
    await expect(upsertOrganizationGwsCredential(oauth)).rejects.toThrow('denied');
    expect(setSecret).not.toHaveBeenCalled();
  });
  it('allows writable Agent members but rejects read-only OAuth targets', async () => {
    await upsertAgentGwsCredential({ ...oauth, projectId: 'agent-a' });
    expect(setSecret).toHaveBeenCalledTimes(1);
    membership = 'viewer';
    await expect(upsertAgentGwsCredential({ ...oauth, projectId: 'agent-a' })).rejects.toThrow('denied');
    expect(setSecret).toHaveBeenCalledTimes(1);
  });
  it('rejects a disabled callback actor before writing tokens', async () => {
    role = 'operator'; active = false;
    await expect(upsertOrganizationGwsCredential(oauth)).rejects.toThrow('denied');
    expect(setSecret).not.toHaveBeenCalled();
  });
});


describe('R3: historical Project creator cannot bypass current membership revocation', () => {
  beforeEach(() => {
    creatorUserId = 7;
    vi.mocked(transaction).mockImplementation(async callback => callback({} as any));
    vi.mocked(withClient).mockReturnValue({ queryOne, query, execute } as any);
  });
  it.each(['viewer', null])('denies creator with membership %s before revealing, rotating, deleting or importing', async currentMembership => {
    membership = currentMembership;
    await expect(revealCredentialValue({ projectId: 'agent-a', actorUserId: 7, credentialId: record.id, purpose: 'review' })).rejects.toThrow('denied');
    await expect(rotateExistingCredential({ credentialId: record.id, secretValue: 'synthetic-only', actorUserId: 7 })).rejects.toThrow('denied');
    await expect(deleteCredential({ credentialId: record.id, actorUserId: 7, scope: 'project', projectId: 'agent-a' })).rejects.toThrow('denied');
    await expect(copyProjectCredential({ sourceProjectId: 'agent-a', targetProjectId: 'agent-b', sourceCredentialId: record.id, actorUserId: 7 })).rejects.toThrow('denied');
    expect(getSecretForProjectBinding).not.toHaveBeenCalled();
    expect(setSecret).not.toHaveBeenCalled();
    expect(vi.mocked(queryOne).mock.calls.some(([sql]) => /^DELETE|^UPDATE|^INSERT/.test(sql))).toBe(false);
  });
  it('honors owner then viewer then removed membership in one long-lived service context', async () => {
    const check = () => assertCredentialManagementAccess({ actorUserId: 7, scope: 'project', projectId: 'agent-a', action: 'reveal' });
    membership = 'owner'; await expect(check()).resolves.toBeUndefined();
    membership = 'viewer'; await expect(check()).rejects.toThrow('denied');
    membership = null; await expect(check()).rejects.toThrow('denied');
  });
  it.each(['operator', 'admin'])('preserves %s company management independently of creator membership', async currentRole => {
    role = currentRole; membership = null;
    await expect(assertCredentialManagementAccess({ actorUserId: 7, scope: 'project', projectId: 'agent-a', action: 'reveal' })).resolves.toBeUndefined();
  });
});
