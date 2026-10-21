import { describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { issueWorkbenchProjectExecutionGrant, verifyWorkbenchProjectExecutionGrant } from './workbench-project-execution-grant.js';

const spec = { jobId: 1, projectId: 'p1', actorUserId: 7, sessionId: '11111111-1111-4111-8111-111111111111', command: 'pwd', cwd: '/workspace', timeoutSec: 10, workbenchRevision: null, environmentKeys: ['GWS_TOKEN'] };

describe('Workbench Project execution grant', () => {
  it('binds one short-lived grant to Worker, Project root, request, and Credential names', () => {
    const now = new Date('2026-08-30T00:00:00Z');
    const grant = issueWorkbenchProjectExecutionGrant({ secret: 'secret', workerId: 'w1', projectRoot: '/srv/workspace/projects/p1', spec, now });
    const claims = verifyWorkbenchProjectExecutionGrant({ grant, secret: 'secret', workerId: 'w1', spec, now });
    expect(claims.projectRoot).toBe('/srv/workspace/projects/p1');
    expect(claims.environmentKeys).toEqual(['GWS_TOKEN']);
  });

  it('rejects another Worker, a changed command, and expiration', () => {
    const now = new Date('2026-08-30T00:00:00Z');
    const grant = issueWorkbenchProjectExecutionGrant({ secret: 'secret', workerId: 'w1', projectRoot: '/srv/workspace/projects/p1', spec, now, ttlMs: 1000 });
    expect(() => verifyWorkbenchProjectExecutionGrant({ grant, secret: 'secret', workerId: 'w2', spec, now })).toThrow('Worker mismatch');
    expect(() => verifyWorkbenchProjectExecutionGrant({ grant, secret: 'secret', workerId: 'w1', spec: { ...spec, command: 'whoami' }, now })).toThrow('request mismatch');
    expect(() => verifyWorkbenchProjectExecutionGrant({ grant, secret: 'secret', workerId: 'w1', spec, now: new Date(now.getTime() + 1001) })).toThrow('expired');
  });
});

const now = new Date('2026-08-30T00:00:00Z');
const projectRoot = '/srv/workspace/projects/p1';
const connectedTarget = (id: string) => `/connected/${createHash('sha256').update(id).digest('hex')}`;
const scope = () => ({ teamId: 'team-a', mounts: [
  { workspaceId: 'p1-files', ownerProjectId: 'p1', source: projectRoot, target: '/workspace', readOnly: false },
  { workspaceId: 'p2-files', ownerProjectId: 'p2', source: '/srv/workspace/projects/p2', target: connectedTarget('p2-files'), readOnly: true },
] });
const issue = (teamScope: unknown) => issueWorkbenchProjectExecutionGrant({ secret: 'secret', workerId: 'w1', projectRoot, spec, now, teamScope } as any);
const verify = (grant: string, extra = {}) => verifyWorkbenchProjectExecutionGrant({ grant, secret: 'secret', workerId: 'w1', spec, now, allowTeamScope: true, ...extra } as any);
const claimsFrom = (grant: string) => JSON.parse(Buffer.from(grant.split('.')[0], 'base64url').toString());
const resigned = (claims: unknown) => {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${createHmac('sha256', 'secret').update(payload).digest('base64url')}`;
};

describe('trusted signed team execution scope (not executor activation)', () => {
  it('returns only the signed scope and its canonical digest', () => {
    const grant = issue(scope());
    const claims = verify(grant) as any;
    expect(claims.teamScope).toEqual(scope());
    expect(claims.teamScopeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(claims.version).toBe(1);
  });
  it('is unsupported by default: existing consumers must explicitly opt in', () => {
    const grant = issue(scope());
    expect(() => verifyWorkbenchProjectExecutionGrant({ grant, secret: 'secret', workerId: 'w1', spec, now })).toThrow('TEAM_EXECUTION_SCOPE_UNSUPPORTED');
    expect(() => verify(grant, { allowTeamScope: false })).toThrow('TEAM_EXECUTION_SCOPE_UNSUPPORTED');
  });
  it('keeps legacy v1 shape/digest and verification unchanged', () => {
    const grant = issueWorkbenchProjectExecutionGrant({ secret: 'secret', workerId: 'w1', projectRoot, spec, now });
    const claims = verifyWorkbenchProjectExecutionGrant({ grant, secret: 'secret', workerId: 'w1', spec, now });
    expect(claims).not.toHaveProperty('teamScope');
    expect(claims).not.toHaveProperty('teamScopeDigest');
    expect(verify(grant)).toEqual(claims);
  });
  it('normalizes mount order to a deterministic signed scope', () => {
    const a = claimsFrom(issue(scope()));
    const reversed = scope(); reversed.mounts.reverse();
    const b = claimsFrom(issue(reversed));
    expect(a.teamScopeDigest).toBeDefined();
    expect(a.teamScopeDigest).toBe(b.teamScopeDigest);
    expect(a.teamScope).toEqual(b.teamScope);
    const sameFields = { mounts: scope().mounts.map(({ workspaceId, ownerProjectId, source, target, readOnly }) =>
      ({ readOnly, target, source, ownerProjectId, workspaceId })), teamId: 'team-a' };
    expect(claimsFrom(issue(sameFields)).teamScopeDigest).toBe(a.teamScopeDigest);
    const signedReordered = claimsFrom(issue(scope())); signedReordered.teamScope.mounts.reverse();
    expect((verify(resigned(signedReordered)) as any).teamScope).toEqual(a.teamScope);
  });
  it('does not sign or merge arbitrary spec/body scope extras', () => {
    const grant = issue(scope());
    const alteredSpec = { ...spec, teamScope: { teamId: 'attacker', mounts: [] }, mounts: [{ source: '/etc', target: '/workspace' }] };
    const claims = verify(grant, { spec: alteredSpec, teamScope: alteredSpec.teamScope, mounts: alteredSpec.mounts }) as any;
    expect(claims.teamScope).toEqual(scope());
    const legacy = issueWorkbenchProjectExecutionGrant({ secret: 'secret', workerId: 'w1', projectRoot, spec: alteredSpec, now });
    expect(verify(legacy)).not.toHaveProperty('teamScope');
  });
  it('rejects signed-scope tampering without resigning', () => {
    const grant = issue(scope());
    const claims = claimsFrom(grant); claims.teamScope.mounts[1].readOnly = false;
    const altered = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${grant.split('.')[1]}`;
    expect(() => verify(altered)).toThrow('signature');
  });
  it('binds team identity, source, target, owner, workspace and mode into the digest', () => {
    const digest = claimsFrom(issue(scope())).teamScopeDigest;
    for (const field of ['teamId', 'readOnly', 'source', 'workspaceId', 'ownerProjectId']) {
      const current = scope();
      if (field === 'teamId') current.teamId = 'team-b';
      if (field === 'readOnly') current.mounts[1].readOnly = false;
      if (field === 'source') current.mounts[1].source = '/srv/workspace/projects/p2-new';
      if (field === 'ownerProjectId') current.mounts[1].ownerProjectId = 'p3';
      if (field === 'workspaceId') { current.mounts[1].workspaceId = 'p3-files'; current.mounts[1].target = connectedTarget('p3-files'); }
      expect(claimsFrom(issue(current)).teamScopeDigest).not.toBe(digest);
    }
  });
  it.each([
    { teamId: '', mounts: [] }, { teamId: 'team-a', mounts: [] },
    { ...scope(), hidden: true }, { ...scope(), teamId: 1 },
    { ...scope(), mounts: 'not-array' }, null,
  ])('rejects invalid or unknown scope fields (%j)', invalid => {
    expect(() => issue(invalid)).toThrow('TEAM_EXECUTION_SCOPE_INVALID');
  });
  it.each([
    { source: '/' }, { source: 'relative/p2' }, { source: '/srv/../etc' },
    { source: '/srv/workspace/projects/p2/' }, { source: '/srv/workspace/projects/p2//nested' },
    { source: '/srv\\projects\\p2' }, { source: '/srv/workspace/projects/p2\nbad' },
    { source: '/srv/workspace/projects/p2\0bad' }, { target: '/workspace/../run' },
    { target: '/run/private' }, { target: '/connected/user-chosen' }, { target: '/connected//nested' },
    { readOnly: 'false' }, { workspaceId: '' }, { workspaceId: ' padded ' },
    { ownerProjectId: '' }, { ownerProjectId: 'owner\nother' }, { extra: true },
  ])('rejects invalid mount fields (%j)', change => {
    const current = scope(); Object.assign(current.mounts[1], change);
    expect(() => issue(current)).toThrow('TEAM_EXECUTION_SCOPE_INVALID');
  });
  it('rejects duplicate workspace/target/source and ancestor overlap', () => {
    for (const change of [
      { ...scope().mounts[0] },
      { ...scope().mounts[1], source: projectRoot },
      { ...scope().mounts[1], source: `${projectRoot}/nested` },
      { ...scope().mounts[1], source: '/srv/workspace/projects' },
      { ...scope().mounts[1], target: '/workspace' },
    ]) {
      const current = scope(); current.mounts[1] = change;
      expect(() => issue(current)).toThrow('TEAM_EXECUTION_SCOPE_INVALID');
    }
  });
  it('requires own owner/root/target consistency', () => {
    for (const change of [{ ownerProjectId: 'p2' }, { source: '/srv/workspace/projects/other' }, { target: connectedTarget('p1-files') }]) {
      const current = scope(); Object.assign(current.mounts[0], change);
      expect(() => issue(current)).toThrow('TEAM_EXECUTION_SCOPE_INVALID');
    }
  });
  it('requires an own mount and rejects duplicate owner or non-object mount entries', () => {
    expect(() => issue({ teamId: 'team-a', mounts: [scope().mounts[1]] })).toThrow('TEAM_EXECUTION_SCOPE_INVALID');
    for (const extra of [null, [], { ...scope().mounts[1], workspaceId: 'alias-files', source: '/srv/workspace/projects/alias', target: connectedTarget('alias-files') }]) {
      expect(() => issue({ teamId: 'team-a', mounts: [...scope().mounts, extra] })).toThrow('TEAM_EXECUTION_SCOPE_INVALID');
    }
  });
  it('limits the signed inventory and does not mutate caller arrays', () => {
    const current = scope(); current.mounts.reverse();
    const before = JSON.stringify(current); issue(current);
    expect(JSON.stringify(current)).toBe(before);
    expect(() => issue({ teamId: 'team-a', mounts: Array.from({ length: 257 }, () => scope().mounts[0]) })).toThrow('TEAM_EXECUTION_SCOPE_INVALID');
  });
  it('revalidates a signed malformed scope/digest rather than trusting HMAC alone', () => {
    const grant = issue(scope());
    const digestOnly = claimsFrom(grant); delete digestOnly.teamScope;
    const scopeOnly = claimsFrom(grant); delete scopeOnly.teamScopeDigest;
    const changedDigest = claimsFrom(grant); changedDigest.teamScopeDigest = '0'.repeat(64);
    const unknown = claimsFrom(grant); unknown.teamScope.extra = true;
    const badMount = claimsFrom(grant); badMount.teamScope.mounts[1].source = '/';
    for (const claims of [digestOnly, scopeOnly, changedDigest, unknown, badMount]) {
      expect(() => verify(resigned(claims))).toThrow('TEAM_EXECUTION_SCOPE_INVALID');
    }
  });
  it('preserves command/root/Worker/expiry binding for team grants', () => {
    const grant = issue(scope());
    expect(() => verify(grant, { spec: { ...spec, command: 'changed' } })).toThrow('request mismatch');
    expect(() => verify(grant, { workerId: 'w2' })).toThrow('Worker mismatch');
    expect(() => verify(grant, { now: new Date(now.getTime() + 60_001) })).toThrow('expired');
    const claims = claimsFrom(grant); claims.projectRoot = '/srv/workspace/projects/other';
    expect(() => verify(resigned(claims))).toThrow('TEAM_EXECUTION_SCOPE_INVALID');
  });
});
