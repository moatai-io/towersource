import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { planTeamWorkspaceMounts, type TeamWorkspaceMountInput } from './team-mount-plan.js';
import { planAgentWorkspaceMounts, type WorkspaceMountCandidate } from './mount-plan.js';

const input: TeamWorkspaceMountInput = {
  agentProjectId: 'a',
  inventory: [{ workspaceId: 'a-files', ownerProjectId: 'a' }, { workspaceId: 'b-files', ownerProjectId: 'b' }],
  storageLocators: [
    { workspaceId: 'a-files', ownerProjectId: 'a', locator: { kind: 'host', root: '/data/a' } },
    { workspaceId: 'b-files', ownerProjectId: 'b', locator: { kind: 'host', root: '/data/b' } },
  ],
  projectRoots: [{ projectId: 'a', root: '/data/a' }, { projectId: 'b', root: '/data/b' }],
};
function withSource(root: string): TeamWorkspaceMountInput {
  return { ...input, storageLocators: [input.storageLocators[0], { ...input.storageLocators[1], locator: { kind: 'host', root } }] };
}

describe('internal team mount intent planner', () => {
  it('plans ordinary team files read-write without project membership or fake grants', () => {
    const mounts = planTeamWorkspaceMounts(input);
    expect(mounts).toEqual([
      { workspaceId: 'a-files', source: '/data/a', target: '/workspace', readOnly: false },
      { workspaceId: 'b-files', source: '/data/b', target: `/connected/${createHash('sha256').update('b-files').digest('hex')}`, readOnly: false },
    ]);
    expect(mounts[1]).not.toHaveProperty('grantVersion');
    expect(planTeamWorkspaceMounts(input)).toEqual(mounts);
  });
  it('does not turn the team inventory into legacy grant authority', () => {
    const candidate: WorkspaceMountCandidate = { workspaceId: 'b-files', locator: { kind: 'host', root: '/data/b' }, facts: {
      user_role: 'member', user_disabled: 0, agent_archived: 0, agent_status: 'active', membership_role: null,
      workspace_state: 'active', owner_project_id: 'b', owner_root_path: '/data/b', owner_archived: 0,
      workspace_kind: 'project', grant_mode: null, grant_version: null, grant_revoked_at: null,
    } };
    expect(() => planAgentWorkspaceMounts({ agentProjectId: 'a', candidates: [candidate], projectRoots: input.projectRoots })).toThrow('AGENT_ACCESS_DENIED');
    expect(planTeamWorkspaceMounts(input)[1].readOnly).toBe(false);
  });
  it('mounts only current team inventory, not every registered locator', () => {
    expect(planTeamWorkspaceMounts({ ...input, inventory: input.inventory.slice(0, 1) })).toHaveLength(1);
    expect(planTeamWorkspaceMounts({ ...input, inventory: [] })).toEqual([]);
  });
  it('does not mutate the server inventory or registry', () => {
    const before = structuredClone(input);
    planTeamWorkspaceMounts(input);
    expect(input).toEqual(before);
  });
  it('rejects missing execution context', () => {
    expect(() => planTeamWorkspaceMounts({ ...input, agentProjectId: ' ' })).toThrow('AGENT_WORKSPACE_CONTEXT_REQUIRED');
  });
  it('rejects an inventory workspace without a registered locator', () => {
    expect(() => planTeamWorkspaceMounts({ ...input, storageLocators: input.storageLocators.slice(0, 1) })).toThrow('WORKSPACE_STORAGE_LOCATOR_UNAVAILABLE');
  });
  it('rejects locator ownership that disagrees with the original inventory', () => {
    expect(() => planTeamWorkspaceMounts({ ...input, storageLocators: [input.storageLocators[0], { ...input.storageLocators[1], ownerProjectId: 'a' }] })).toThrow('WORKSPACE_MOUNT_REGISTRY_MISMATCH');
  });
  it('rejects source paths that disagree with the original project registry', () => {
    expect(() => planTeamWorkspaceMounts(withSource('/data/other'))).toThrow('WORKSPACE_MOUNT_SOURCE_UNREGISTERED');
    expect(() => planTeamWorkspaceMounts({ ...input, projectRoots: [] })).toThrow('WORKSPACE_MOUNT_SOURCE_UNREGISTERED');
  });
  it('rejects a remote locator rather than inventing a host mirror', () => {
    expect(() => planTeamWorkspaceMounts({ ...input, storageLocators: [input.storageLocators[0], { ...input.storageLocators[1], locator: { kind: 'worker', workerId: 'worker-b' } }] })).toThrow('WORKSPACE_REMOTE_MOUNT_UNSUPPORTED');
  });
  it.each(['relative', '/', '/data/b/../b', '/data/b/', '/data/b\u0000', '/data/b\n', '/data/b\u007f'])('rejects invalid source %j', root => {
    expect(() => planTeamWorkspaceMounts(withSource(root))).toThrow('WORKSPACE_MOUNT_SOURCE_INVALID');
  });
  it('rejects a nested registered project even outside the current team inventory', () => {
    expect(() => planTeamWorkspaceMounts({ ...input, projectRoots: [...input.projectRoots, { projectId: 'outside', root: '/data/b/nested' }] })).toThrow('WORKSPACE_MOUNT_NESTED_PROJECT');
  });
  it('rejects duplicate workspace inventory and locator registry entries', () => {
    expect(() => planTeamWorkspaceMounts({ ...input, inventory: [...input.inventory, input.inventory[1]] })).toThrow('WORKSPACE_MOUNT_DUPLICATE_OR_INVALID');
    expect(() => planTeamWorkspaceMounts({ ...input, storageLocators: [...input.storageLocators, input.storageLocators[1]] })).toThrow('WORKSPACE_MOUNT_DUPLICATE_OR_INVALID');
  });
  it.each(['workspaceId', 'ownerProjectId'] as const)('rejects empty inventory %s', field => {
    expect(() => planTeamWorkspaceMounts({ ...input, inventory: [{ ...input.inventory[0], [field]: ' ' }] })).toThrow('WORKSPACE_MOUNT_DUPLICATE_OR_INVALID');
  });
  it('rejects multiple workspace aliases for the same registered project root', () => {
    expect(() => planTeamWorkspaceMounts({ ...input,
      inventory: [...input.inventory, { workspaceId: 'b-alias', ownerProjectId: 'b' }],
      storageLocators: [...input.storageLocators, { ...input.storageLocators[1], workspaceId: 'b-alias' }],
    })).toThrow('WORKSPACE_MOUNT_OVERLAP');
  });
  it('rejects overlapping roots regardless of inventory order', () => {
    const nested: TeamWorkspaceMountInput = { ...input,
      storageLocators: [input.storageLocators[0], { ...input.storageLocators[1], locator: { kind: 'host', root: '/data/a/nested' } }],
      projectRoots: [{ projectId: 'a', root: '/data/a' }, { projectId: 'b', root: '/data/a/nested' }],
    };
    expect(() => planTeamWorkspaceMounts(nested)).toThrow('WORKSPACE_MOUNT_NESTED_PROJECT');
    expect(() => planTeamWorkspaceMounts({ ...nested, inventory: [...nested.inventory].reverse() })).toThrow('WORKSPACE_MOUNT_NESTED_PROJECT');
  });
});
it.each([false, true])('shares same-owner nested-root overlap checks (reversed=%s)', reversed => {
  const nestedAlias: TeamWorkspaceMountInput = {
    agentProjectId: 'a',
    inventory: [{ workspaceId: 'b-files', ownerProjectId: 'b' }, { workspaceId: 'b-alias', ownerProjectId: 'b' }],
    storageLocators: [
      { workspaceId: 'b-files', ownerProjectId: 'b', locator: { kind: 'host', root: '/data/b' } },
      { workspaceId: 'b-alias', ownerProjectId: 'b', locator: { kind: 'host', root: '/data/b/nested' } },
    ],
    projectRoots: [{ projectId: 'b', root: '/data/b' }, { projectId: 'b', root: '/data/b/nested' }],
  };
  if (reversed) nestedAlias.inventory.reverse();
  expect(() => planTeamWorkspaceMounts(nestedAlias)).toThrow('WORKSPACE_MOUNT_OVERLAP');
});
it('does not confuse similarly prefixed sibling paths with nesting or overlap', () => {
  expect(planTeamWorkspaceMounts({ ...input,
    storageLocators: [input.storageLocators[0], { ...input.storageLocators[1], locator: { kind: 'host', root: '/data/a-sibling' } }],
    projectRoots: [input.projectRoots[0], { projectId: 'b', root: '/data/a-sibling' }],
  })).toHaveLength(2);
});
