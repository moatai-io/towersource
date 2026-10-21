import { generateKeyPairSync, createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { issueCanonicalFileWriteGrant, verifyCanonicalFileWriteGrant } from './canonical-file-write-grant.js';
const now = 1_800_000_000_000;
const scope = { workerId: 'worker-a', projectId: 'project-a', projectRoot: '/work/projects/a', actorUserId: 7, relativePath: 'notes/a.md', mode: 'replace' as const, bodySha256: 'a'.repeat(64), bytes: 4 };
const keys = generateKeyPairSync('ed25519');
const issue = (overrides = {}) => issueCanonicalFileWriteGrant({ signingKey: keys.privateKey, scope: { ...scope, ...overrides }, nowMs: now });
const verify = (token: string, overrides = {}) => verifyCanonicalFileWriteGrant({ verificationKey: keys.publicKey, token, expected: scope, nowMs: now + 1, ...overrides });
it('round trips exact write scope with a distinct purpose and unique nonce', () => {
 const first = verify(issue());
 expect(first.scope).toEqual(scope);
 expect(first.purpose).toBe('canonical-file-write');
 expect(first.nonce).not.toBe(verify(issue()).nonce);
});
it.each([
 { workerId: 'other' }, { projectId: 'other' }, { projectRoot: '/work/projects/b' },
 { actorUserId: 8 }, { relativePath: 'notes/b.md' }, { mode: 'exclusive' },
 { bodySha256: 'b'.repeat(64) }, { bytes: 5 },
])('rejects a different request binding %j', changed => {
 expect(() => verify(issue(), { expected: { ...scope, ...changed } })).toThrow();
});
it('rejects invalid signature, expiry, future issuance and excess lifetime', () => {
 expect(() => verify(issue(), { verificationKey: generateKeyPairSync('ed25519').publicKey })).toThrow();
 expect(() => verify(issue(), { nowMs: now + 60_000 })).toThrow();
 expect(() => verify(issue(), { nowMs: now - 1 })).toThrow();
 expect(() => issueCanonicalFileWriteGrant({ signingKey: keys.privateKey, scope, nowMs: now, ttlMs: 60_001 })).toThrow();
});
it.each([
 { projectRoot: '/' }, { projectRoot: '/work/../secret' }, { relativePath: '../secret' },
 { relativePath: '/secret' }, { relativePath: 'a//b' }, { relativePath: '.' },
 { actorUserId: 0 }, { bytes: -1 }, { mode: 'shell' }, { bodySha256: 'invalid' },
 { mode: 'cas' }, { expectedSha256: 'b'.repeat(64) }, { unknown: true },
])('rejects malformed scope %j', changed => { expect(() => issue(changed)).toThrow(); });
it('binds CAS precondition and rejects oversized CAS before signing', () => {
 const cas = { ...scope, mode: 'cas' as const, expectedSha256: 'c'.repeat(64) };
 const token = issueCanonicalFileWriteGrant({ signingKey: keys.privateKey, scope: cas, nowMs: now });
 expect(verify(token, { expected: cas }).scope).toEqual(cas);
 expect(() => verify(token, { expected: { ...cas, expectedSha256: 'd'.repeat(64) } })).toThrow();
 expect(() => issueCanonicalFileWriteGrant({ signingKey: keys.privateKey, scope: { ...cas, bytes: 1024 * 1024 + 1 }, nowMs: now })).toThrow();
});
it('rejects malformed or oversized tokens', () => {
 for (const token of ['', 'a.b.c', 'x'.repeat(40_000)]) expect(() => verify(token)).toThrow();
});

it('never accepts a private key on the verifier or a public key for signing', () => {
 expect(() => verify(issue(), { verificationKey: keys.privateKey })).toThrow();
 expect(() => issueCanonicalFileWriteGrant({ signingKey: keys.publicKey, scope })).toThrow();
});
it('rejects old shared-secret HMAC tokens', () => {
 const payload = issue().split('.')[0];
 const signature = createHmac('sha256', 'worker-shared-secret').update(`canonical-file-write:v1:${payload}`).digest('base64url');
 expect(() => verify(`${payload}.${signature}`)).toThrow();
});
