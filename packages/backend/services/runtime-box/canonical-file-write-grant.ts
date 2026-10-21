import { KeyObject, randomUUID, sign, verify } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const cleanPath = (s: string) => !/[\x00-\x1f\x7f\\]/.test(s) && path.posix.normalize(s) === s;
export const canonicalFileWriteScopeSchema = z.object({
  workerId: z.string().min(1).max(200), projectId: z.string().min(1).max(200),
  projectRoot: z.string().max(4096).refine(s => s.startsWith('/') && s !== '/' && !s.endsWith('/') && cleanPath(s)),
  actorUserId: z.number().int().positive().safe(),
  relativePath: z.string().min(1).max(4096).refine(s => !s.startsWith('/') && s !== '.' && !s.endsWith('/') && !s.split('/').includes('..') && cleanPath(s)),
  mode: z.enum(['replace', 'exclusive', 'cas']), bytes: z.number().int().min(0).max(100 * 1024 * 1024),
  bodySha256: digest, expectedSha256: digest.optional(),
}).strict().superRefine((s, ctx) => {
  if ((s.mode === 'cas') !== (s.expectedSha256 !== undefined) || (s.mode === 'cas' && s.bytes > 1024 * 1024)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid CAS precondition or size' });
  }
});
export type CanonicalFileWriteScope = z.infer<typeof canonicalFileWriteScopeSchema>;
const claimsSchema = z.object({
  purpose: z.literal('canonical-file-write'), version: z.literal(1), nonce: z.string().uuid(),
  issuedAtMs: z.number().int().safe(), expiresAtMs: z.number().int().safe(), scope: canonicalFileWriteScopeSchema,
}).strict();
const MAX_TTL = 60_000;
const signatureInput = (payload: string) => Buffer.from(`canonical-file-write:ed25519:v1:${payload}`);
function assertKey(key: KeyObject, type: 'private' | 'public') {
 if (!(key instanceof KeyObject) || key.type !== type || key.asymmetricKeyType !== 'ed25519') throw new Error('FILE_WRITE_GRANT_KEY_INVALID');
}
/** Backend holds the private key; Worker receives only the trusted public key.
 * Exact intent signature is not current membership, root identity or one-time
 * consumption. Those checks remain required before publication. No HMAC fallback.
 */
export function issueCanonicalFileWriteGrant(input: { signingKey: KeyObject; scope: CanonicalFileWriteScope; nowMs?: number; ttlMs?: number }): string {
  assertKey(input.signingKey, 'private');
 const now = input.nowMs ?? Date.now(); const ttl = input.ttlMs ?? MAX_TTL;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_TTL) throw new Error('FILE_WRITE_GRANT_TIME_INVALID');
  const claims = claimsSchema.parse({ purpose: 'canonical-file-write', version: 1, nonce: randomUUID(), issuedAtMs: now, expiresAtMs: now + ttl, scope: input.scope });
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(null, signatureInput(payload), input.signingKey).toString('base64url')}`;
}
export function verifyCanonicalFileWriteGrant(input: { verificationKey: KeyObject; token: string; expected: CanonicalFileWriteScope; nowMs?: number }) {
  assertKey(input.verificationKey, 'public');
 if (typeof input.token !== 'string' || input.token.length > 32_768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input.token)) throw new Error('FILE_WRITE_GRANT_INVALID');
  const [payload, signature] = input.token.split('.');
  if (!verify(null, signatureInput(payload), input.verificationKey, Buffer.from(signature, 'base64url'))) throw new Error('FILE_WRITE_GRANT_SIGNATURE');
 const claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
  const now = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(now) || claims.issuedAtMs > now || claims.expiresAtMs <= now || claims.expiresAtMs <= claims.issuedAtMs || claims.expiresAtMs - claims.issuedAtMs > MAX_TTL) throw new Error('FILE_WRITE_GRANT_EXPIRED');
  if (JSON.stringify(claims.scope) !== JSON.stringify(canonicalFileWriteScopeSchema.parse(input.expected))) throw new Error('FILE_WRITE_GRANT_SCOPE_MISMATCH');
  return claims;
}
