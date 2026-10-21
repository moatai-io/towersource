import { createHash, type KeyObject } from 'node:crypto';
import { issueCanonicalFileWriteGrant, type CanonicalFileWriteScope } from './canonical-file-write-grant.js';

/** Internal one-shot transport, not authorization or executor selection.
 * Caller must resolve current user/Agent access, canonical storage and trusted
 * Worker endpoint immediately before dispatch. No host-write fallback/retries.
 * NOT_CONFIRMED requires reconciliation, not blind repetition.
 */
export async function sendCanonicalTextWrite(input: Omit<CanonicalFileWriteScope, 'bytes' | 'bodySha256'> & {
 baseUrl: string; secret: string; signingKey: KeyObject; content: string; timeoutMs?: number;
}): Promise<{ bytesWritten: number }> {
 const base = new URL(input.baseUrl);
 if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('CANONICAL_WRITE_ENDPOINT_INVALID');
 const timeout = input.timeoutMs ?? 30_000;
 if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 60_000) throw new Error('CANONICAL_WRITE_TIMEOUT_INVALID');
 const body = Buffer.from(input.content, 'utf8');
 if (body.toString('utf8') !== input.content) throw new Error('CANONICAL_WRITE_UTF8_INVALID');
 const scope: CanonicalFileWriteScope = { workerId: input.workerId, projectId: input.projectId, projectRoot: input.projectRoot,
 actorUserId: input.actorUserId, relativePath: input.relativePath, mode: input.mode, bytes: body.byteLength,
 bodySha256: createHash('sha256').update(body).digest('hex'),
 ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }) };
 const token = issueCanonicalFileWriteGrant({ signingKey: input.signingKey, scope });
 const url = new URL(`/v1/canonical-files/${encodeURIComponent(scope.projectId)}/content`, base);
 url.searchParams.set('path', scope.relativePath);
 let response: Response;
 try {
  response = await fetch(url, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(timeout),
   headers: { authorization: `Bearer ${input.secret}`, 'content-length': String(body.byteLength),
    'x-tower-write-scope': Buffer.from(JSON.stringify(scope)).toString('base64url'), 'x-tower-write-grant': token }, body });
 } catch { throw new Error('CANONICAL_WRITE_NOT_CONFIRMED'); }
 if (response.status !== 200) {
  await response.body?.cancel();
  throw new Error(response.status === 403 ? 'CANONICAL_WRITE_DENIED' : [404,503].includes(response.status) ? 'CANONICAL_WRITE_UNAVAILABLE' : 'CANONICAL_WRITE_NOT_CONFIRMED');
 }
 try {
  const reader = response.body?.getReader(); if (!reader) throw new Error('missing receipt');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 1024) throw new Error('receipt too large'); chunks.push(part.value); } }
  finally { await reader.cancel(); }
  const receipt = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!receipt || Object.keys(receipt).length !== 1 || receipt.bytesWritten !== scope.bytes) throw new Error('invalid receipt');
  return { bytesWritten: scope.bytes };
 } catch { throw new Error('CANONICAL_WRITE_NOT_CONFIRMED'); }
}
