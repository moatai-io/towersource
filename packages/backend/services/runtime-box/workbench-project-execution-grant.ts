import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { RemoteWorkbenchJobSpec } from '../execution/remote-job-runner.js';

export const WORKBENCH_PROJECT_EXECUTION_GRANT_VERSION = 1;
const DEFAULT_TTL_MS = 60_000;

export interface WorkbenchTeamExecutionMount {
  workspaceId: string;
  ownerProjectId: string;
  source: string;
  target: string;
  readOnly: boolean;
}
export interface WorkbenchTeamExecutionScope {
  teamId: string;
  mounts: readonly WorkbenchTeamExecutionMount[];
}

/** Trusted server input only, never an arbitrary spec/body field. This binds
 * lexical intent, not membership freshness, full registry overlap, realpath or
 * pinned inodes. A Worker consumer must independently enforce those boundaries.
 */
function canonicalTeamScope(value: unknown, projectId: string, projectRoot: string): WorkbenchTeamExecutionScope {
  const invalid = (): never => { throw new Error('TEAM_EXECUTION_SCOPE_INVALID'); };
  const exactKeys = (record: unknown, keys: string[]): record is Record<string, unknown> =>
    Boolean(record && typeof record === 'object' && !Array.isArray(record)
      && Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key)));
  const identifier = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200
    && id.trim() === id && !/[\x00-\x20\x7f]/.test(id);
  const absolutePath = (root: unknown): root is string => typeof root === 'string' && root.length <= 4096
    && path.posix.isAbsolute(root) && path.posix.resolve(root) === root && root !== '/'
    && !/[\\\x00-\x1f\x7f]/.test(root);
  if (!exactKeys(value, ['teamId', 'mounts']) || !identifier(value.teamId)
    || !Array.isArray(value.mounts) || value.mounts.length === 0 || value.mounts.length > 256) return invalid();
  const mounts: WorkbenchTeamExecutionMount[] = [];
  const workspaceIds = new Set<string>();
  const owners = new Set<string>();
  for (const entry of value.mounts) {
    if (!exactKeys(entry, ['workspaceId', 'ownerProjectId', 'source', 'target', 'readOnly'])
      || !identifier(entry.workspaceId) || !identifier(entry.ownerProjectId)
      || !absolutePath(entry.source) || !absolutePath(entry.target) || typeof entry.readOnly !== 'boolean') return invalid();
    const own = entry.ownerProjectId === projectId;
    const expectedTarget = own ? '/workspace' : `/connected/${createHash('sha256').update(entry.workspaceId).digest('hex')}`;
    if (entry.target !== expectedTarget || (own && entry.source !== projectRoot)
      || workspaceIds.has(entry.workspaceId) || owners.has(entry.ownerProjectId)) return invalid();
    for (const previous of mounts) {
      if (entry.source === previous.source || entry.source.startsWith(`${previous.source}/`)
        || previous.source.startsWith(`${entry.source}/`) || entry.target === previous.target) return invalid();
    }
    workspaceIds.add(entry.workspaceId);
    owners.add(entry.ownerProjectId);
    // Fixed field and codepoint mount order makes the digest independent of
    // caller object insertion order, locale and inventory query ordering.
    mounts.push({ workspaceId: entry.workspaceId, ownerProjectId: entry.ownerProjectId,
      source: entry.source, target: entry.target, readOnly: entry.readOnly });
  }
  if (!owners.has(projectId)) return invalid();
  mounts.sort((a, b) => a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0);
  return { teamId: value.teamId, mounts };
}

function teamScopeDigest(scope: WorkbenchTeamExecutionScope): string {
  return createHash('sha256').update(JSON.stringify(scope)).digest('hex');
}

export interface WorkbenchProjectExecutionGrantClaims {
  version: typeof WORKBENCH_PROJECT_EXECUTION_GRANT_VERSION;
  grantId: string;
  workerId: string;
  projectId: string;
  projectRoot: string;
  requestDigest: string;
  environmentKeys: string[];
  issuedAt: string;
  expiresAt: string;
  /** Returned only from the signed payload. Never merge unsigned request mounts. */
  teamScope?: WorkbenchTeamExecutionScope;
  teamScopeDigest?: string;
}

function encode(value: string): string { return Buffer.from(value, 'utf8').toString('base64url'); }
function sign(payload: string, secret: string): string { return createHmac('sha256', secret).update(payload).digest('base64url'); }
function sortedKeys(values: string[]): string[] { return [...new Set(values)].sort(); }

export function workbenchExecutionRequestDigest(spec: RemoteWorkbenchJobSpec): string {
  return createHash('sha256').update(JSON.stringify({
    ...(spec.lifecycle ? { lifecycle: spec.lifecycle } : {}),
    jobId: spec.jobId,
    projectId: spec.projectId,
    actorUserId: spec.actorUserId,
    sessionId: spec.sessionId ?? 'system',
    workspaceId: spec.workspaceId ?? null,
    command: spec.command,
    cwd: spec.cwd ?? '/workspace',
    timeoutSec: spec.timeoutSec ?? null,
    workbenchRevision: spec.workbenchRevision,
    environmentKeys: sortedKeys(spec.environmentKeys),
    artifacts: spec.artifacts ?? [],
  })).digest('hex');
}

export function issueWorkbenchProjectExecutionGrant(input: {
  secret: string;
  workerId: string;
  projectRoot: string;
  spec: RemoteWorkbenchJobSpec;
  now?: Date;
  ttlMs?: number;
  /** Must come from freshly verified server context, separate from Job spec. */
  teamScope?: WorkbenchTeamExecutionScope;
}): string {
  if (!input.secret) throw new Error('execution grant secret is required');
  if (!input.workerId.trim()) throw new Error('execution grant Worker is required');
  if (!path.isAbsolute(input.projectRoot)) throw new Error('execution grant Project root must be absolute');
  const now = input.now ?? new Date();
  const teamScope = input.teamScope === undefined ? undefined
    : canonicalTeamScope(input.teamScope, input.spec.projectId, path.resolve(input.projectRoot));
  const claims: WorkbenchProjectExecutionGrantClaims = {
    version: WORKBENCH_PROJECT_EXECUTION_GRANT_VERSION,
    grantId: randomUUID(),
    workerId: input.workerId,
    projectId: input.spec.projectId,
    projectRoot: path.resolve(input.projectRoot),
    requestDigest: workbenchExecutionRequestDigest(input.spec),
    environmentKeys: sortedKeys(input.spec.environmentKeys),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
    ...(teamScope ? { teamScope, teamScopeDigest: teamScopeDigest(teamScope) } : {}),
  };
  const payload = encode(JSON.stringify(claims));
  return `${payload}.${sign(payload, input.secret)}`;
}

export function verifyWorkbenchProjectExecutionGrant(input: {
  grant: string;
  secret: string;
  workerId: string;
  spec: RemoteWorkbenchJobSpec;
  now?: Date;
  /** Default false: existing consumers must not silently ignore team mounts.
   * Opt in only after scope enforcement is implemented at the Worker boundary.
   */
  allowTeamScope?: boolean;
}): WorkbenchProjectExecutionGrantClaims {
  const [payload, suppliedSignature, extra] = input.grant.split('.');
  if (!payload || !suppliedSignature || extra) throw new Error('execution grant format is invalid');
  const expectedSignature = sign(payload, input.secret);
  const a = Buffer.from(suppliedSignature); const b = Buffer.from(expectedSignature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('execution grant signature is invalid');
  let claims: WorkbenchProjectExecutionGrantClaims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { throw new Error('execution grant payload is invalid'); }
  const now = input.now ?? new Date();
  if (claims.version !== WORKBENCH_PROJECT_EXECUTION_GRANT_VERSION) throw new Error('execution grant version is unsupported');
  if (!claims.grantId || claims.workerId !== input.workerId) throw new Error('execution grant Worker mismatch');
  if (claims.projectId !== input.spec.projectId) throw new Error('execution grant Project mismatch');
  if (!path.isAbsolute(claims.projectRoot)) throw new Error('execution grant Project root is invalid');
  if (claims.requestDigest !== workbenchExecutionRequestDigest(input.spec)) throw new Error('execution grant request mismatch');
  if (JSON.stringify(claims.environmentKeys) !== JSON.stringify(sortedKeys(input.spec.environmentKeys))) throw new Error('execution grant Credential scope mismatch');
  if (Date.parse(claims.issuedAt) > now.getTime() + 5_000 || Date.parse(claims.expiresAt) <= now.getTime()) throw new Error('execution grant is expired or invalid');
  if (Object.hasOwn(claims, 'teamScope') || Object.hasOwn(claims, 'teamScopeDigest')) {
    if (input.allowTeamScope !== true) throw new Error('TEAM_EXECUTION_SCOPE_UNSUPPORTED');
    const scope = canonicalTeamScope(claims.teamScope, claims.projectId, claims.projectRoot);
    if (typeof claims.teamScopeDigest !== 'string' || claims.teamScopeDigest !== teamScopeDigest(scope)) {
      throw new Error('TEAM_EXECUTION_SCOPE_INVALID');
    }
    // Return a canonical copy of signed scope only; caller arrays are not inputs.
    return { ...claims, teamScope: scope };
  }
  return claims;
}
