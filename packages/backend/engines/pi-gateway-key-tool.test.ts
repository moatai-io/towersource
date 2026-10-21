import { beforeEach, describe, expect, it, vi } from 'vitest';

const issueOrRotateZuploKeyAndStore = vi.fn();
vi.mock('../services/gateway-profile/zuplo-key-issuance.js', () => ({ issueOrRotateZuploKeyAndStore }));

const { createGatewayKeyIssueAndStoreTool } = await import('./pi-gateway-key-tool.js');

const params = {
  operation: 'issue',
  account: 'demo-account',
  bucketId: 'bckt_demo',
  consumerName: 'vm-demo',
  credentialId: 'zuplo-virtual-key-vm-demo',
  credentialEnvName: 'ZUPLO_VIRTUAL_KEY',
  credentialDisplayName: 'VM demo gateway key',
  confirmed: true,
};

describe('gateway_key_issue_and_store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    issueOrRotateZuploKeyAndStore.mockResolvedValue({
      operation: 'issue', account: 'demo-account', bucketId: 'bckt_demo', consumerId: 'csmr_demo', consumerName: 'vm-demo',
      keyId: 'key_demo', credentialId: params.credentialId, credentialEnvName: 'ZUPLO_VIRTUAL_KEY', credentialScope: 'workspace', stored: true,
    });
  });

  it.each([undefined, 'member', 'viewer', 'guest'])('is unavailable to non-operator role %s', userRole => {
    expect(createGatewayKeyIssueAndStoreTool({ userId: 7, userRole, projectId: 'p1' })).toBeUndefined();
  });

  it.each(['admin', 'operator'])('is available to privileged role %s', userRole => {
    expect(createGatewayKeyIssueAndStoreTool({ userId: 7, userRole, projectId: 'p1' })?.name).toBe('gateway_key_issue_and_store');
  });

  it('is unavailable to restricted or externally deployed Agents', () => {
    expect(createGatewayKeyIssueAndStoreTool({ userId: 7, userRole: 'operator', projectId: 'p1', channelSafeToolsOnly: true })).toBeUndefined();
  });

  it('returns a secret-free receipt and passes only non-secret inputs', async () => {
    const tool: any = createGatewayKeyIssueAndStoreTool({ userId: 7, userRole: 'operator', projectId: 'p1' });
    const result = await tool.execute('t1', params, new AbortController().signal);

    expect(issueOrRotateZuploKeyAndStore).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 7, projectId: 'p1', ...params }));
    expect(result.details).toMatchObject({ keyId: 'key_demo', stored: true });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-issued|management-secret/);
  });

  it('reports Vault failure as recovery-required without provider diagnostics', async () => {
    const error = Object.assign(new Error('Zuplo issued a key but Vault storage failed; recovery is required before retry'), { code: 'ZUPLO_KEY_VAULT_STORE_FAILED' });
    issueOrRotateZuploKeyAndStore.mockRejectedValue(error);
    const tool: any = createGatewayKeyIssueAndStoreTool({ userId: 7, userRole: 'operator', projectId: 'p1' });
    const result = await tool.execute('t1', params);

    expect(result.isError).toBe(true);
    expect(result.details).toEqual({ stored: false, code: 'ZUPLO_KEY_VAULT_STORE_FAILED', recoveryRequired: true });
    expect(result.content[0].text).not.toContain('synthetic');
  });
});
