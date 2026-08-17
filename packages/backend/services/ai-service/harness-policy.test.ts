import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOne = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({ queryOne }));

const { canonicalizeServiceHarnessPolicy } = await import('./harness-policy.js');

const registryRow = {
  harness_status: 'active',
  profile_status: 'active',
  engine: 'pi',
  profile_version: 1,
};

function policy(overrides: Record<string, unknown> = {}) {
  return {
    refuseWithoutEvidence: true,
    allowedTools: ['Bash', 'write'],
    harnessBinding: {
      harnessId: 'quick-web-research',
      harnessVersion: 1,
      runtimeProfileId: 'web-only',
      runtimeProfileVersion: 1,
      engine: 'pi',
      model: 'litellm-responses/smart',
      status: 'published',
    },
    ...overrides,
  };
}

describe('AI Service Harness policy canonicalization', () => {
  beforeEach(() => queryOne.mockReset());

  it('replaces client-asserted tools with the published effective capability surface', async () => {
    queryOne.mockResolvedValueOnce(registryRow);
    const result = await canonicalizeServiceHarnessPolicy(policy());
    expect(result.allowedTools).toEqual(['WebFetch', 'WebSearch']);
    expect(result.capabilityIds).toEqual(['web.fetch', 'web.search']);
    expect(result.harnessBinding).toMatchObject({
      harnessId: 'quick-web-research',
      harnessVersion: 1,
      runtimeProfileId: 'web-only',
      runtimeProfileVersion: 1,
      status: 'published',
    });
  });

  it('rejects an unknown or inactive Registry tuple', async () => {
    queryOne.mockResolvedValueOnce(undefined);
    await expect(canonicalizeServiceHarnessPolicy(policy())).rejects.toThrow('Published Harness not found');
  });

  it('rejects a client-asserted unpublished binding', async () => {
    await expect(canonicalizeServiceHarnessPolicy(policy({
      harnessBinding: { ...(policy().harnessBinding as object), status: 'draft' },
    }))).rejects.toThrow('Only a published Harness');
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('rejects Registry and requested profile version mismatches', async () => {
    queryOne.mockResolvedValueOnce({ ...registryRow, profile_version: 2 });
    await expect(canonicalizeServiceHarnessPolicy(policy())).rejects.toThrow('does not match the published Registry tuple');
  });

  it('rejects a published tuple without a matching runtime implementation', async () => {
    queryOne.mockResolvedValueOnce(registryRow);
    await expect(canonicalizeServiceHarnessPolicy(policy({
      harnessBinding: { ...(policy().harnessBinding as object), harnessVersion: 2 },
    }))).rejects.toThrow('Unknown Harness version');
  });
});
