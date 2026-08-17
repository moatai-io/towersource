import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOne = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({ queryOne }));
const { buildServiceAgentRuntimePrompt, canonicalizeServiceExperienceSnapshot, normalizeServiceIdentity, serviceIdentityFromExperience } = await import('./service-identity.js');

describe('AI Service identity snapshot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('normalizes a complete immutable behavior-only identity', () => {
    expect(normalizeServiceIdentity({ displayName: ' Researcher ', face: ' character:korean-diverse-9 ', role: 'Public research', promise: 'Cited answers', instruction: 'Use public sources.' })).toEqual({
      displayName: 'Researcher', face: 'character:korean-diverse-9', role: 'Public research', promise: 'Cited answers', instruction: 'Use public sources.',
    });
  });

  it('rejects incomplete identity snapshots instead of inheriting ambient Project identity', () => {
    expect(() => serviceIdentityFromExperience({ identity: { displayName: 'Only a name' } })).toThrow('role required');
  });

  it('copies source Agent behavior into a Deployment snapshot without copying authority fields', async () => {
    queryOne.mockResolvedValue({ service_name: 'Customer Research', service_description: 'Research public facts', owner_project_id: 'source-project', display_name: 'Source Agent', face: 'character:korean-diverse-9', role: 'Research lead', promise: 'Evidence first', instruction: 'Verify sources.', instruction_version: 8 });
    const result = await canonicalizeServiceExperienceSnapshot('svc-1', { greeting: 'Hello' });
    expect(result).toEqual({ greeting: 'Hello', identity: {
      displayName: 'Customer Research', face: 'character:korean-diverse-9', role: 'Research lead', promise: 'Evidence first', instruction: 'Verify sources.', sourceAgentProjectId: 'source-project', sourceAgentProfileVersion: 8,
    } });
    expect(JSON.stringify(result)).not.toContain('authority');
    expect(JSON.stringify(result)).not.toContain('toolPolicy');
  });

  it('builds an explicit separate Service Agent prompt', () => {
    const prompt = buildServiceAgentRuntimePrompt({ displayName: 'Researcher', role: 'Public research', promise: 'Cited answers', instruction: 'Use public sources.', sourceAgentProjectId: 'private-project', sourceAgentProfileVersion: 3 });
    expect(prompt).toContain('a separate deployed Service Agent');
    expect(prompt).toContain('Do not inherit the source Project Agent identity');
    expect(prompt).not.toContain('private-project');
  });
});
