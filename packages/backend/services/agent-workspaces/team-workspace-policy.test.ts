import { describe, expect, it } from 'vitest';
import { listTeamWorkspaceIds, requireTeamAgentUse, type TeamWorkspacePolicyInput } from './team-workspace-policy.js';

const facts = (): TeamWorkspacePolicyInput => ({
  currentUser: { active: true, role: 'member' },
  teamMemberships: [{ teamId: 'team-a', active: true }, { teamId: 'team-b', active: true }],
  agent: { active: true, teamId: 'team-a' },
  workspaces: [
    { workspaceId: 'workspace-a', teamId: 'team-a', registered: true, active: true },
    { workspaceId: 'workspace-b', teamId: 'team-b', registered: true, active: true },
  ],
});

describe('requireTeamAgentUse', () => {
  const admissionFacts = (): Pick<TeamWorkspacePolicyInput, 'currentUser' | 'teamMemberships' | 'agent'> => {
    const { currentUser, teamMemberships, agent } = facts();
    return { currentUser, teamMemberships, agent };
  };

  it.each(['admin', 'operator', 'member'])('admits an explicitly enrolled %s without workspace inventory', role => {
    expect(requireTeamAgentUse({ ...admissionFacts(), currentUser: { active: true, role } })).toBeUndefined();
  });

  it.each(['admin', 'operator', 'member'])('requires explicit Agent-team membership even for %s', role => {
    expect(() => requireTeamAgentUse({
      ...admissionFacts(), currentUser: { active: true, role }, teamMemberships: [{ teamId: 'team-b', active: true }],
    })).toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it.each(['viewer', 'guest', 'unknown'])('denies role %s', role => {
    expect(() => requireTeamAgentUse({ ...admissionFacts(), currentUser: { active: true, role } }))
      .toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it('denies an inactive current account', () => {
    expect(() => requireTeamAgentUse({ ...admissionFacts(), currentUser: { active: false, role: 'admin' } }))
      .toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it('denies an inactive Agent', () => {
    expect(() => requireTeamAgentUse({ ...admissionFacts(), agent: { active: false, teamId: 'team-a' } }))
      .toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it('denies revoked/inactive team membership', () => {
    expect(() => requireTeamAgentUse({ ...admissionFacts(), teamMemberships: [{ teamId: 'team-a', active: false }] }))
      .toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it.each([null, '', '   '])('rejects a teamless Agent (%s) without organization fallback', teamId => {
    expect(() => requireTeamAgentUse({ ...admissionFacts(), agent: { active: true, teamId } }))
      .toThrow('TEAM_WORKSPACE_CONTEXT_REQUIRED');
  });

  it('does not mutate current server facts or introduce Project membership facts', () => {
    const input = admissionFacts();
    const before = structuredClone(input);
    requireTeamAgentUse(input);
    expect(input).toEqual(before);
  });
});

describe('listTeamWorkspaceIds', () => {
  it('uses only the running Agent team, not every team of the person', () => {
    expect(listTeamWorkspaceIds(facts())).toEqual(['workspace-a']);
  });

  it.each(['admin', 'operator', 'member'])('allows an active explicitly enrolled %s', role => {
    expect(listTeamWorkspaceIds({ ...facts(), currentUser: { active: true, role } })).toEqual(['workspace-a']);
  });

  it.each(['viewer', 'guest', 'unknown'])('does not promote %s to an execution grant', role => {
    expect(() => listTeamWorkspaceIds({ ...facts(), currentUser: { active: true, role } }))
      .toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it('denies an inactive current account', () => {
    expect(() => listTeamWorkspaceIds({ ...facts(), currentUser: { active: false, role: 'admin' } }))
      .toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it('denies an inactive Agent', () => {
    expect(() => listTeamWorkspaceIds({ ...facts(), agent: { active: false, teamId: 'team-a' } }))
      .toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it.each(['admin', 'operator', 'member'])('requires explicit Agent-team enrollment even for %s', role => {
    expect(() => listTeamWorkspaceIds({
      ...facts(), currentUser: { active: true, role },
      teamMemberships: [{ teamId: 'team-b', active: true }],
    })).toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it('denies revoked/inactive team enrollment', () => {
    expect(() => listTeamWorkspaceIds({ ...facts(), teamMemberships: [{ teamId: 'team-a', active: false }] }))
      .toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it('does not treat Session access or organization admission as team membership', () => {
    const input = { ...facts(), teamMemberships: [], sessionAccess: true, organizationExecutionAdmission: true };
    expect(() => listTeamWorkspaceIds(input)).toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it.each([null, '', '   '])('does not turn a teamless Agent (%s) into organization access', teamId => {
    expect(() => listTeamWorkspaceIds({ ...facts(), agent: { active: true, teamId } }))
      .toThrow('TEAM_WORKSPACE_CONTEXT_REQUIRED');
  });

  it('excludes inactive, unregistered, unassigned and other-team workspaces', () => {
    const input = facts();
    input.workspaces = [
      ...input.workspaces,
      { workspaceId: 'inactive', teamId: 'team-a', registered: true, active: false },
      { workspaceId: 'unregistered', teamId: 'team-a', registered: false, active: true },
      { workspaceId: 'unassigned', teamId: null, registered: true, active: true },
    ];
    expect(listTeamWorkspaceIds(input)).toEqual(['workspace-a']);
  });

  it('requires no target Project membership and returns only existing workspace IDs', () => {
    const workspace = {
      ...facts().workspaces[0], targetProjectMembership: null,
      rootPath: '/private/host-root', sessionId: 'private-session', credentialId: 'private-credential',
      systemAccess: true,
    };
    expect(listTeamWorkspaceIds({ ...facts(), workspaces: [workspace] })).toEqual(['workspace-a']);
  });

  it('returns an empty list when no registered active workspace belongs to the Agent team', () => {
    expect(listTeamWorkspaceIds({ ...facts(), workspaces: [] })).toEqual([]);
  });

  it('does not change or reorder the server facts', () => {
    const input = facts();
    const before = structuredClone(input);
    listTeamWorkspaceIds(input);
    expect(input).toEqual(before);
  });

  it.each(['', '   '])('rejects an invalid eligible workspace ID (%s)', workspaceId => {
    expect(() => listTeamWorkspaceIds({
      ...facts(), workspaces: [{ ...facts().workspaces[0], workspaceId }],
    })).toThrow('TEAM_WORKSPACE_INVENTORY_INVALID');
  });

  it('rejects duplicate eligible IDs rather than publishing an ambiguous inventory', () => {
    const workspace = facts().workspaces[0];
    expect(() => listTeamWorkspaceIds({ ...facts(), workspaces: [workspace, workspace] }))
      .toThrow('TEAM_WORKSPACE_INVENTORY_INVALID');
  });
});
