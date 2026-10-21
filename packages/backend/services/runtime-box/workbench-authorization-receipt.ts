import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { AUTHORIZATION_POLICY_ID, type AuthorityCapability } from '../authority/authorization-policy.js';

export const WORKBENCH_AUTHORIZATION_RECEIPT_VERSION = 1;
const DEFAULT_TTL_MS = 60_000;

export interface WorkbenchAuthorizationClaims {
  version: typeof WORKBENCH_AUTHORIZATION_RECEIPT_VERSION;
  receiptId: string;
  policyId: typeof AUTHORIZATION_POLICY_ID;
  capability: AuthorityCapability;
  actorUserId: number;
  projectId: string;
  sessionId: string;
  jobId: number;
  environmentKeys: string[];
  issuedAt: string;
  expiresAt: string;
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueWorkbenchAuthorizationReceipt(input: {
  secret: string;
  actorUserId: number;
  projectId: string;
  sessionId: string;
  jobId: number;
  environmentKeys: string[];
  capability?: AuthorityCapability;
  now?: Date;
  ttlMs?: number;
}): string {
  if (!input.secret) throw new Error('authorization receipt secret is required');
  const now = input.now ?? new Date();
  const claims: WorkbenchAuthorizationClaims = {
    version: WORKBENCH_AUTHORIZATION_RECEIPT_VERSION,
    receiptId: randomUUID(),
    policyId: AUTHORIZATION_POLICY_ID,
    capability: input.capability ?? 'worker:execute',
    actorUserId: input.actorUserId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    jobId: input.jobId,
    environmentKeys: [...new Set(input.environmentKeys)].sort(),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
  };
  const payload = encode(JSON.stringify(claims));
  return `${payload}.${sign(payload, input.secret)}`;
}

export function verifyWorkbenchAuthorizationReceipt(input: {
  receipt: string;
  secret: string;
  expected: {
    actorUserId: number;
    projectId: string;
    sessionId: string;
    jobId: number;
    environmentKeys: string[];
    capability?: AuthorityCapability;
  };
  now?: Date;
}): WorkbenchAuthorizationClaims {
  if (!input.secret || typeof input.receipt !== 'string' || input.receipt.length > 32_768) {
    throw new Error('authorization receipt input is invalid');
  }
  const [payload, suppliedSignature, extra] = input.receipt.split('.');
  if (!payload || !suppliedSignature || extra) throw new Error('authorization receipt format is invalid');
  const expectedSignature = sign(payload, input.secret);
  const a = Buffer.from(suppliedSignature);
  const b = Buffer.from(expectedSignature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('authorization receipt signature is invalid');

  let claims: WorkbenchAuthorizationClaims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as WorkbenchAuthorizationClaims; }
  catch { throw new Error('authorization receipt payload is invalid'); }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new Error('authorization receipt payload is invalid');
  }
  const expectedKeys = [...new Set(input.expected.environmentKeys)].sort();
  const now = input.now ?? new Date();
  if (claims.version !== WORKBENCH_AUTHORIZATION_RECEIPT_VERSION) throw new Error('authorization receipt version is unsupported');
  if (claims.policyId !== AUTHORIZATION_POLICY_ID) throw new Error('authorization receipt policy is unsupported');
  if (claims.capability !== (input.expected.capability ?? 'worker:execute')) throw new Error('authorization receipt capability mismatch');
  if (claims.actorUserId !== input.expected.actorUserId) throw new Error('authorization receipt actor mismatch');
  if (claims.projectId !== input.expected.projectId) throw new Error('authorization receipt Project mismatch');
  if (claims.sessionId !== input.expected.sessionId) throw new Error('authorization receipt Session mismatch');
  if (claims.jobId !== input.expected.jobId) throw new Error('authorization receipt Job mismatch');
  if (JSON.stringify(claims.environmentKeys) !== JSON.stringify(expectedKeys)) throw new Error('authorization receipt Credential scope mismatch');
  const issuedAt = typeof claims.issuedAt === 'string' ? Date.parse(claims.issuedAt) : NaN;
  const expiresAt = typeof claims.expiresAt === 'string' ? Date.parse(claims.expiresAt) : NaN;
  if (typeof claims.receiptId !== 'string' || !claims.receiptId.trim() || claims.receiptId.length > 128
    || !Number.isFinite(now.getTime()) || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || expiresAt <= issuedAt || issuedAt > now.getTime() + 5_000 || expiresAt <= now.getTime()) {
    throw new Error('authorization receipt is expired or invalid');
  }
  return claims;
}
