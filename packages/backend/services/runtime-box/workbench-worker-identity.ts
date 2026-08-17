/**
 * Owns: scoped JWT identity claims for Remote Workbench Worker control-plane calls.
 * Public API: issueWorkbenchWorkerIdentity, verifyWorkbenchWorkerIdentity.
 * See: workspace/decisions/2026-08-10-tower-control-plane-only-project-compute.md.
 */

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../../config.js';

export const WORKBENCH_WORKER_AUDIENCE = 'workbench-worker';

export interface WorkbenchWorkerIdentity {
  workerId: string;
  projectIds: string[];
  capabilities: string[];
  jti: string;
  expiresAt: string;
}

type WorkbenchWorkerClaims = {
  aud: string | string[];
  sub: string;
  worker_id: string;
  project_ids: string[];
  capabilities: string[];
  jti: string;
  exp: number;
};

const WORKER_ID = /^[a-zA-Z0-9._-]{1,120}$/;

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].sort();
}

/** Issue an expiring Worker identity bounded to exact Project and capability ceilings. */
export function issueWorkbenchWorkerIdentity(input: {
  workerId: string;
  projectIds: string[];
  capabilities: string[];
  expiresIn?: string | number;
}): { token: string; identity: WorkbenchWorkerIdentity } {
  if (!WORKER_ID.test(input.workerId)) throw new Error('WORKER_ID_INVALID');
  const projectIds = sortedUnique(input.projectIds);
  const capabilities = sortedUnique(input.capabilities);
  if (projectIds.length === 0 || capabilities.length === 0) throw new Error('WORKER_SCOPE_EMPTY');
  const jti = crypto.randomUUID();
  const token = jwt.sign({
    worker_id: input.workerId,
    project_ids: projectIds,
    capabilities,
  }, config.jwtSecret, {
    audience: WORKBENCH_WORKER_AUDIENCE,
    subject: `workbench-worker:${input.workerId}`,
    jwtid: jti,
    expiresIn: (input.expiresIn ?? '24h') as any,
  });
  const decoded = jwt.decode(token) as WorkbenchWorkerClaims | null;
  if (!decoded?.exp) throw new Error('WORKER_IDENTITY_ISSUE_FAILED');
  return {
    token,
    identity: { workerId: input.workerId, projectIds, capabilities, jti, expiresAt: new Date(decoded.exp * 1000).toISOString() },
  };
}

/** Verify signature, expiration, audience, subject, and bounded Worker claims. */
export function verifyWorkbenchWorkerIdentity(token: string): WorkbenchWorkerIdentity | null {
  try {
    const claims = jwt.verify(token, config.jwtSecret, { audience: WORKBENCH_WORKER_AUDIENCE }) as WorkbenchWorkerClaims;
    if (!WORKER_ID.test(claims.worker_id) || claims.sub !== `workbench-worker:${claims.worker_id}` || !claims.jti || !claims.exp) return null;
    const projectIds = sortedUnique(Array.isArray(claims.project_ids) ? claims.project_ids : []);
    const capabilities = sortedUnique(Array.isArray(claims.capabilities) ? claims.capabilities : []);
    if (projectIds.length === 0 || capabilities.length === 0) return null;
    return { workerId: claims.worker_id, projectIds, capabilities, jti: claims.jti, expiresAt: new Date(claims.exp * 1000).toISOString() };
  } catch {
    return null;
  }
}
