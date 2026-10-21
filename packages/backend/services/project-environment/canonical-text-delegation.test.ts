const keys = generateKeyPairSync('ed25519');
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), send: vi.fn(), auth: vi.fn(), writable: vi.fn(), denied: vi.fn() }));
vi.mock('./project-workspace-files.js', () => ({ resolveCurrentProjectWorkspaceWrite: mocks.resolve }));
vi.mock('../runtime-box/canonical-file-write-transport.js', () => ({ sendCanonicalTextWrite: mocks.send }));
vi.mock('../auth/auth.js', () => ({ getUserAuthState: mocks.auth }));
vi.mock('../pm/project-access.js', () => ({ isPathWritableByRole: mocks.writable, isDotfileDenied: mocks.denied }));
import { issueCanonicalFileWriteGrant } from '../runtime-box/canonical-file-write-grant.js';
import { delegateCanonicalTextWrite, recheckCanonicalTextWrite } from './canonical-text-delegation.js';
const reference = { projectId: 'p', projectRoot: '/work/p', relativePath: 'a.txt', hostPath: '/work/p/a.txt' };
const input = { reference, actorUserId: 7, content: 'new', target: { workerId: 'w', baseUrl: 'http://localhost:9999', secret: 'synthetic-test', signingKey: keys.privateKey } };
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ role: 'member', disabled: false, approvalStatus: 'active' }); mocks.writable.mockResolvedValue(true); mocks.denied.mockReturnValue(false); mocks.resolve.mockResolvedValue(reference); mocks.send.mockResolvedValue({ bytesWritten: 3 }); });
it('uses fresh gateway admission and canonical bytes without changing storage authority', async () => {
 expect(await delegateCanonicalTextWrite(input)).toEqual({ storageKind: 'host', bytesWritten: 3 });
 expect(mocks.resolve).toHaveBeenCalledWith({ reference, actorUserId: 7 });
 expect(mocks.send).toHaveBeenCalledWith({ ...input.target, projectId: 'p', projectRoot: '/work/p', actorUserId: 7, relativePath: 'a.txt', mode: 'replace', content: 'new' });
});
it('does not send after current access fails', async () => {
 mocks.resolve.mockRejectedValue(new Error('PROJECT_FILE_SOURCE_ACCESS_REVOKED'));
 await expect(delegateCanonicalTextWrite(input)).rejects.toThrow('REVOKED'); expect(mocks.send).not.toHaveBeenCalled();
});
it('does not treat legacy Worker storage as canonical', async () => {
 mocks.resolve.mockResolvedValue({ ...reference, workerAuthority: { workerId: 'w' } });
 await expect(delegateCanonicalTextWrite(input)).rejects.toThrow('CANONICAL_WRITE_HOST_REQUIRED'); expect(mocks.send).not.toHaveBeenCalled();
});
it('preserves exclusive semantics and does not retry unknown outcomes', async () => {
 mocks.send.mockRejectedValue(new Error('CANONICAL_WRITE_NOT_CONFIRMED'));
 await expect(delegateCanonicalTextWrite({ ...input, exclusive: true })).rejects.toThrow('NOT_CONFIRMED');
 expect(mocks.send).toHaveBeenCalledTimes(1); expect(mocks.send.mock.calls[0][0].mode).toBe('exclusive');
});

it('does not dispatch a protected path even with valid Project write membership', async () => {
 mocks.denied.mockReturnValue(true);
 await expect(delegateCanonicalTextWrite(input)).rejects.toThrow('CANONICAL_WRITE_PATH_DENIED');
 expect(mocks.send).not.toHaveBeenCalled();
});
it('does not dispatch when the most-specific path policy denies write', async () => {
 mocks.writable.mockResolvedValue(false);
 await expect(delegateCanonicalTextWrite(input)).rejects.toThrow('CANONICAL_WRITE_PATH_DENIED');
 expect(mocks.send).not.toHaveBeenCalled();
});
it('does not use a stale requester role after gateway resolution', async () => {
 mocks.auth.mockResolvedValue({ role: 'admin', disabled: true, approvalStatus: 'active' });
 await expect(delegateCanonicalTextWrite(input)).rejects.toThrow('CANONICAL_WRITE_ACCESS_REVOKED');
 expect(mocks.send).not.toHaveBeenCalled();
});

const scope = { workerId: 'w', projectId: 'p', projectRoot: '/work/p', actorUserId: 7, relativePath: 'a.txt', mode: 'replace' as const, bytes: 3, bodySha256: 'a'.repeat(64) };
const signed = () => issueCanonicalFileWriteGrant({ signingKey: keys.privateKey, scope });
it('rechecks signed current authority without issuing another write', async () => {
 await expect(recheckCanonicalTextWrite({ authenticatedWorkerId: 'w', verificationKey: keys.publicKey, token: signed(), scope })).resolves.toBeUndefined();
 expect(mocks.resolve).toHaveBeenCalledWith({ reference, actorUserId: 7 });
 expect(mocks.send).not.toHaveBeenCalled();
});
it.each(['different-worker', ''])('rejects an unrelated authenticated Worker %s before account discovery', async workerId => {
 await expect(recheckCanonicalTextWrite({ authenticatedWorkerId: workerId, verificationKey: keys.publicKey, token: signed(), scope })).rejects.toThrow('WORKER_MISMATCH');
 expect(mocks.resolve).not.toHaveBeenCalled();
});
it('rejects forged scope before account discovery', async () => {
 await expect(recheckCanonicalTextWrite({ authenticatedWorkerId: 'w', verificationKey: keys.publicKey, token: signed(), scope: { ...scope, actorUserId: 99 } })).rejects.toThrow();
 expect(mocks.resolve).not.toHaveBeenCalled();
});
it('honors current revocation and path denial on callback', async () => {
 mocks.writable.mockResolvedValue(false);
 await expect(recheckCanonicalTextWrite({ authenticatedWorkerId: 'w', verificationKey: keys.publicKey, token: signed(), scope })).rejects.toThrow('PATH_DENIED');
 expect(mocks.send).not.toHaveBeenCalled();
});
