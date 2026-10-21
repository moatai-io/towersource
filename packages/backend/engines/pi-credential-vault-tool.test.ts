import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db/pg-repo.js', () => ({ queryOne: vi.fn() }));
import { queryOne } from '../db/pg-repo.js';
let currentRole = 'member';
let membership: string | null = 'member';
let active = true;
beforeEach(() => {
  vi.resetAllMocks(); currentRole = 'member'; membership = 'member'; active = true;
  vi.mocked(queryOne).mockImplementation(async sql => sql.includes('FROM users') ? (active ? { role: currentRole } : null) : { creator_user_id: 99, membership_role: membership });
});
import { createCredentialVaultInputTool } from './pi-credential-vault-tool.js';

const params = {
  id: 'openai-image-default',
  provider: 'openai',
  displayName: 'OpenAI Image',
  envName: 'OPENAI_IMAGE_API_KEY',
};

describe('credential_vault_input', () => {
  it('defaults secure input to the current Agent and exposes only team/Agent scopes', () => {
    const tool: any = createCredentialVaultInputTool({ userId: 7, userRole: 'member', projectId: 'p1' });
    expect(tool.promptSnippet).toContain('passwords, login credentials, tokens');
    expect(tool.promptSnippet).toContain('accepts an offer to open a secure input');
    expect(tool.promptGuidelines.join('\n')).toContain('안전 입력창을 열어드릴까요?');
    expect(tool.promptGuidelines.join('\n')).toContain('wait for consent');
    expect(tool.promptGuidelines.join('\n')).toContain('already explicitly asked to register or rotate');
    expect(tool.promptGuidelines).toContain('Use scope=project by default. It creates an Agent-dedicated Credential whose project_id is the current Agent Project.');
    expect(tool.promptGuidelines).toContain('Use scope=workspace only when an admin/operator explicitly requests a team-shared Credential. Workspace Credentials are automatically available to every ordinary Project; there is no separate grant or policy step.');
    expect(JSON.stringify(tool.parameters)).not.toContain('personal');
    expect(JSON.stringify(tool.parameters)).not.toContain('grantToCurrentProject');
    expect(tool.promptGuidelines.join('\n')).toContain('not a general-purpose store for identity documents');
  });

  it('opens project-scoped secure input without receiving a secret', async () => {
    const tool = createCredentialVaultInputTool({ userId: 7, userRole: 'member', projectId: 'p1' });
    const result: any = await tool.execute('t1', params as any);
    expect(result.details).toEqual({ secureInput: true });
    expect(result.content[0].text).not.toContain('sk-');
    expect(result.content[0].text).toContain('not confirmed');
    expect(result.content[0].text).not.toContain('input opened');
  });

  it('refuses workspace scope for non-company managers', async () => {
    const tool = createCredentialVaultInputTool({ userId: 7, userRole: 'member', projectId: 'p1' });
    const result: any = await tool.execute('t1', { ...params, scope: 'workspace' } as any);
    expect(result.content[0].text).toContain('refused');
    expect(result.isError).toBe(true);
  });

  it('accepts multi-field credentials without a top-level envName', async () => {
    const tool = createCredentialVaultInputTool({ userId: 7, userRole: 'admin', projectId: 'p1' });
    const result: any = await tool.execute('t1', {
      ...params,
      inputType: 'fields',
      envName: undefined,
      fields: [{ key: 'NAVER_CLIENT_ID' }, { key: 'NAVER_CLIENT_SECRET' }],
    } as any);
    expect(result.details).toEqual({ secureInput: true });
  });

  it('refuses ordinary JSON input without an envName', async () => {
    const tool = createCredentialVaultInputTool({ userId: 7, userRole: 'admin', projectId: 'p1' });
    const result: any = await tool.execute('t1', { ...params, inputType: 'json', envName: undefined } as any);
    expect(result.content[0].text).toContain('envName is required');
  });

  it('opens project-scoped secure input for Google credential JSON without envName', async () => {
    const tool = createCredentialVaultInputTool({ userId: 7, userRole: 'member', projectId: 'p1' });
    const result: any = await tool.execute('t1', { id: 'google-agent', provider: 'google', displayName: 'Agent Google', inputType: 'json', scope: 'project' } as any);
    expect(result.isError).not.toBe(true);
    expect(result.details).toEqual({ secureInput: true });
  });

  it('refuses Google credential JSON as a team-shared input', async () => {
    const tool = createCredentialVaultInputTool({ userId: 7, userRole: 'admin', projectId: 'p1' });
    const result: any = await tool.execute('t1', { id: 'google-shared', provider: 'google', displayName: 'Shared Google', inputType: 'json', scope: 'workspace' } as any);
    expect(result.content[0].text).toContain('Agent-dedicated');
  });

  it('refuses project scope without a current project', async () => {
    const tool = createCredentialVaultInputTool({ userId: 7, userRole: 'admin' });
    const result: any = await tool.execute('t1', params as any);
    expect(result.content[0].text).toContain('no project');
  });

  it('accepts a multi-field credential without a top-level env name', async () => {
    const tool = createCredentialVaultInputTool({ userId: 7, userRole: 'member', projectId: 'p1' });
    const result: any = await tool.execute('t1', {
      id: 'naver', provider: 'naver', displayName: 'Naver', inputType: 'fields',
      fields: [{ key: 'NAVER_CLIENT_ID' }, { key: 'NAVER_CLIENT_SECRET' }],
    } as any);
    expect(result.details).toEqual({ secureInput: true });
  });

  it('accepts Google credential JSON without an env name for the current Agent', async () => {
    const tool = createCredentialVaultInputTool({ userId: 7, userRole: 'member', projectId: 'p1' });
    const result: any = await tool.execute('t1', {
      id: 'google-sa', provider: 'google', displayName: 'Google service account', inputType: 'json',
    } as any);
    expect(result.details).toEqual({ secureInput: true });
  });
});


describe('secure-input live entry authority', () => {
  it.each(['operator', 'admin'])('allows current %s workspace management despite an older member snapshot', async role => {
    currentRole = role;
    const tool = createCredentialVaultInputTool({ userId: 7, userRole: 'member', projectId: 'p1' });
    expect((await tool.execute('t1', { ...params, scope: 'workspace' } as any) as any).details).toEqual({ secureInput: true });
  });
  it('rejects stale admin after demotion', async () => {
    const tool = createCredentialVaultInputTool({ userId: 7, userRole: 'admin', projectId: 'p1' });
    expect((await tool.execute('t1', { ...params, scope: 'workspace' } as any) as any).isError).toBe(true);
  });
  it.each(['viewer', 'guest'])('rejects current %s with writable membership', async role => {
    currentRole = role;
    expect((await createCredentialVaultInputTool({ userId: 7, userRole: 'admin', projectId: 'p1' }).execute('t1', params as any) as any).isError).toBe(true);
  });
  it('rejects revoked read-only membership and disabled accounts', async () => {
    const tool = createCredentialVaultInputTool({ userId: 7, userRole: 'member', projectId: 'p1' });
    membership = 'viewer'; expect((await tool.execute('t1', params as any) as any).isError).toBe(true);
    membership = 'member'; active = false; expect((await tool.execute('t1', params as any) as any).isError).toBe(true);
  });
  it('fails closed on a DB error, without echoing diagnostic details', async () => {
    vi.mocked(queryOne).mockRejectedValue(new Error('synthetic-private-diagnostic'));
    const result = await createCredentialVaultInputTool({ userId: 7, projectId: 'p1' }).execute('t1', params as any);
    expect((result as any).isError).toBe(true); expect(JSON.stringify(result)).not.toContain('synthetic-private-diagnostic');
  });
  it('does not accept missing requester identity or invalid scopes', async () => {
    expect((await createCredentialVaultInputTool({ userRole: 'admin', projectId: 'p1' }).execute('t1', params as any) as any).isError).toBe(true);
    expect((await createCredentialVaultInputTool({ userId: 7, projectId: 'p1' }).execute('t1', { ...params, scope: 'personal' } as any) as any).isError).toBe(true);
  });
});
