import { describe, expect, it } from 'vitest';
import { createCredentialVaultInputTool } from './pi-credential-vault-tool.js';

const params = {
  id: 'openai-image-default',
  provider: 'openai',
  displayName: 'OpenAI Image',
  envName: 'OPENAI_IMAGE_API_KEY',
};

describe('credential_vault_input', () => {
  it('defaults secure input to the current Agent while keeping personal legacy explicit-only', () => {
    const tool: any = createCredentialVaultInputTool({ userRole: 'member', projectId: 'p1' });
    expect(tool.promptSnippet).toContain('passwords, login credentials, tokens');
    expect(tool.promptSnippet).toContain('accepts an offer to open a secure input');
    expect(tool.promptGuidelines.join('\n')).toContain('안전 입력창을 열어드릴까요?');
    expect(tool.promptGuidelines.join('\n')).toContain('wait for consent');
    expect(tool.promptGuidelines.join('\n')).toContain('already explicitly asked to register or rotate');
    expect(tool.promptGuidelines).toContain('Use scope=project and grantToCurrentProject=true by default. In the product model this creates an Agent Connection for the current Agent, including user-owned operational accounts used by that Agent.');
    expect(tool.promptGuidelines).toContain('Use scope=personal only when the user explicitly requests the legacy personal Connection model. Use workspace only when an admin explicitly requests an Organization Connection.');
    expect(tool.promptGuidelines.join('\n')).toContain('not a general-purpose store for identity documents');
  });

  it('opens project-scoped secure input without receiving a secret', async () => {
    const tool = createCredentialVaultInputTool({ userRole: 'member', projectId: 'p1' });
    const result: any = await tool.execute('t1', params as any);
    expect(result.details).toEqual({ secureInput: true });
    expect(result.content[0].text).not.toContain('sk-');
  });

  it('refuses workspace scope for non-admin users', async () => {
    const tool = createCredentialVaultInputTool({ userRole: 'member', projectId: 'p1' });
    const result: any = await tool.execute('t1', { ...params, scope: 'workspace' } as any);
    expect(result.content[0].text).toContain('refused');
  });

  it('accepts multi-field credentials without a top-level envName', async () => {
    const tool = createCredentialVaultInputTool({ userRole: 'admin', projectId: 'p1' });
    const result: any = await tool.execute('t1', {
      ...params,
      inputType: 'fields',
      envName: undefined,
      fields: [{ key: 'NAVER_CLIENT_ID' }, { key: 'NAVER_CLIENT_SECRET' }],
    } as any);
    expect(result.details).toEqual({ secureInput: true });
  });

  it('refuses JSON input without an envName', async () => {
    const tool = createCredentialVaultInputTool({ userRole: 'admin', projectId: 'p1' });
    const result: any = await tool.execute('t1', { ...params, inputType: 'json', envName: undefined } as any);
    expect(result.content[0].text).toContain('envName is required');
  });

  it('refuses project scope without a current project', async () => {
    const tool = createCredentialVaultInputTool({ userRole: 'admin' });
    const result: any = await tool.execute('t1', params as any);
    expect(result.content[0].text).toContain('no project');
  });

  it('accepts a multi-field credential without a top-level env name', async () => {
    const tool = createCredentialVaultInputTool({ userRole: 'member', projectId: 'p1' });
    const result: any = await tool.execute('t1', {
      id: 'naver', provider: 'naver', displayName: 'Naver', inputType: 'fields',
      fields: [{ key: 'NAVER_CLIENT_ID' }, { key: 'NAVER_CLIENT_SECRET' }],
    } as any);
    expect(result.details).toEqual({ secureInput: true });
  });

  it('requires an env name for JSON credentials', async () => {
    const tool = createCredentialVaultInputTool({ userRole: 'member', projectId: 'p1' });
    const result: any = await tool.execute('t1', {
      id: 'google-sa', provider: 'google', displayName: 'Google service account', inputType: 'json',
    } as any);
    expect(result.content[0].text).toContain('envName is required');
  });
});
