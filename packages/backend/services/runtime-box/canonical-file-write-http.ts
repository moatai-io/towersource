import type { KeyObject } from 'node:crypto';
import type http from 'node:http';
import { verifyCanonicalFileWriteGrant, type CanonicalFileWriteScope } from './canonical-file-write-grant.js';
import { receiveWorkerProjectTextWrite } from './worker-project-text-write.js';

/** Trusted installation callbacks and public verification key, never request fields.
 * authorize checks current access, storage/root identity and protected paths.
 * consume must be persistent and atomic across restarts. No automatic retries.
 */
export interface CanonicalFileWriteAuthority {
  verificationKey: KeyObject;
  authorize(scope: CanonicalFileWriteScope, token: string): Promise<void>;
  consume(nonce: string, expiresAtMs: number): Promise<boolean>;
}
export async function receiveCanonicalFileWriteHttp(input: {
 request: http.IncomingMessage; response: http.ServerResponse; workerId: string;
 projectId: string; relativePath: string; authority: CanonicalFileWriteAuthority;
}): Promise<void> {
 const { request, response, authority } = input;
 let publication = false;
 try {
  const token = request.headers['x-tower-write-grant']; const encoded = request.headers['x-tower-write-scope'];
  if (typeof token !== 'string' || typeof encoded !== 'string' || encoded.length > 16_384) throw new Error('INVALID');
  const expected: CanonicalFileWriteScope = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  const claims = verifyCanonicalFileWriteGrant({ verificationKey: authority.verificationKey, token, expected });
  if (claims.scope.workerId !== input.workerId || claims.scope.projectId !== input.projectId || claims.scope.relativePath !== input.relativePath
    || request.headers['content-length'] !== String(claims.scope.bytes)) throw new Error('SCOPE_MISMATCH');
  await authority.authorize(claims.scope, token);
  if (!await authority.consume(claims.nonce, claims.expiresAtMs)) throw new Error('REPLAY');
  publication = true;
  const bytesWritten = await receiveWorkerProjectTextWrite({
    projectRoot: claims.scope.projectRoot, relativePath: claims.scope.relativePath, mode: claims.scope.mode,
    expectedBytes: claims.scope.bytes, expectedSha256: claims.scope.expectedSha256, expectedBodySha256: claims.scope.bodySha256,
    chunks: request,
    beforePublish: async () => {
      publication = false;
      await authority.authorize(claims.scope, token);
      verifyCanonicalFileWriteGrant({ verificationKey: authority.verificationKey, token, expected: claims.scope });
      if (request.aborted) throw new Error('ABORTED');
      publication = true;
    },
  });
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ bytesWritten }));
 } catch {
  response.writeHead(publication ? 409 : 403, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: publication ? 'CANONICAL_WRITE_NOT_CONFIRMED' : 'CANONICAL_WRITE_DENIED' }));
 }
}
