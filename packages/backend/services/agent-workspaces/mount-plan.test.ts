import { expect, it } from 'vitest';
import { planAgentWorkspaceMounts, type WorkspaceMountCandidate } from './mount-plan.js';
const candidate: WorkspaceMountCandidate = { workspaceId: 'b-files', locator: { kind: 'host', root: '/data/b' }, facts: {
  user_role: 'member', user_disabled: 0, agent_archived: 0, agent_status: 'active', membership_role: 'member', workspace_state: 'active',
  owner_project_id: 'b', owner_root_path: '/data/b', owner_archived: 0, workspace_kind: 'project', grant_mode: 'read', grant_version: 1, grant_revoked_at: null,
} };
const run = (c = candidate, projectRoots = [{ projectId: 'b', root: '/data/b' }]) => planAgentWorkspaceMounts({ agentProjectId: 'a', candidates: [c], projectRoots });
it('preserves read-only direct grants and generates a stable safe target', () => {
  expect(run()[0]).toMatchObject({ source: '/data/b', readOnly: true, grantVersion: 1 });
  expect(run()[0].target).toMatch(/^\/connected\/[a-f0-9]{64}$/);
  expect(run()).toEqual(run());
});
it('allows read-write only when the requester is writable', () => {
  const rw = { ...candidate, facts: { ...candidate.facts, grant_mode: 'read-write' } };
  expect(run(rw)[0].readOnly).toBe(false);
  expect(run({ ...rw, facts: { ...rw.facts, membership_role: 'viewer' } })[0].readOnly).toBe(true);
});
it('uses the canonical workspace target for own workspace', () => {
  expect(run({ ...candidate, facts: { ...candidate.facts, owner_project_id: 'a', grant_mode: null } }, [{ projectId: 'a', root: '/data/b' }])[0].target).toBe('/workspace');
});
it.each([null, 'revoked'])('never mounts a missing or revoked direct grant: %s', revoked => {
  expect(() => run({ ...candidate, facts: { ...candidate.facts, grant_mode: revoked ? 'read' : null, grant_revoked_at: revoked } })).toThrow('NOT_GRANTED');
});
it('rejects nested project exposure through a parent root', () => {
  expect(() => run(candidate, [{ projectId: 'b', root: '/data/b' }, { projectId: 'c', root: '/data/b/private' }])).toThrow('NESTED_PROJECT');
});
it('does not pretend a remote Worker source is locally mounted', () => {
  expect(() => run({ ...candidate, locator: { kind: 'worker', workerId: 'w' } })).toThrow('REMOTE_MOUNT_UNSUPPORTED');
});
it('rejects unregistered or mismatched source roots', () => {
  expect(() => run(candidate, [])).toThrow('UNREGISTERED');
  expect(() => run({ ...candidate, locator: { kind: 'host', root: '/etc' } })).toThrow('SOURCE_INVALID');
});
it('rejects duplicate workspace entries', () => {
  expect(() => planAgentWorkspaceMounts({ agentProjectId: 'a', candidates: [candidate, candidate], projectRoots: [{ projectId: 'b', root: '/data/b' }] })).toThrow('DUPLICATE');
});
it('preserves the complete legacy mount record after geometry extraction', () => {
  expect(run()).toEqual([{ workspaceId: 'b-files', source: '/data/b',
    target: '/connected/5f8ccd731c2b14cfa61decc1b3b21ff2f8ace66a2168e997fa681d4a7c894e79', readOnly: true, grantVersion: 1 }]);
});
it('keeps legacy authorization failure ahead of unsafe source validation', () => {
  expect(() => run({ ...candidate, locator: { kind: 'host', root: '/' }, facts: { ...candidate.facts, membership_role: null } })).toThrow('AGENT_ACCESS_DENIED');
});
it('still requires owner-root facts independently of the project registry', () => {
  expect(() => run({ ...candidate, facts: { ...candidate.facts, owner_root_path: undefined } })).toThrow('SOURCE_INVALID');
});
it('rejects duplicate sources even when workspace IDs differ', () => {
  expect(() => planAgentWorkspaceMounts({ agentProjectId: 'a', candidates: [candidate, { ...candidate, workspaceId: 'b-alias' }],
    projectRoots: [{ projectId: 'b', root: '/data/b' }] })).toThrow('OVERLAP');
});
it('keeps runtime viewer access read-only even on a read-write grant', () => {
  expect(run({ ...candidate, facts: { ...candidate.facts, grant_mode: 'read-write', user_role: 'viewer' } })[0].readOnly).toBe(true);
});
