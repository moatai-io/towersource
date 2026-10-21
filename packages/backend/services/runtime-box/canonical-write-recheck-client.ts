import { canonicalFileWriteScopeSchema, type CanonicalFileWriteScope } from './canonical-file-write-grant.js';

/** Configuration must be installation-owned. Uses the existing Worker JWT,
 * never user/browser or transport bearer identity. No endpoint discovery,
 * retries, response-body logging or fallback authorization.
 */
export function createCanonicalWriteRecheckClient(input: {
 backendUrl: string; workerIdentityToken: string; timeoutMs?: number;
}): (scope: CanonicalFileWriteScope, token: string) => Promise<void> {
 const base = new URL(input.backendUrl); const timeout = input.timeoutMs ?? 5000;
 if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash
   || !input.workerIdentityToken.trim() || !Number.isInteger(timeout) || timeout <= 0 || timeout > 30_000) throw new Error('CANONICAL_WRITE_RECHECK_CONFIG_INVALID');
 const url = new URL('/api/workbench-workers/canonical-write/recheck', base);
 return async (scope, token) => {
  const parsed = canonicalFileWriteScopeSchema.parse(scope);
  if (typeof token !== 'string' || !token || token.length > 32768) throw new Error('CANONICAL_WRITE_RECHECK_TOKEN_INVALID');
  let response: Response;
  try {
   response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: { authorization: `Bearer ${input.workerIdentityToken}`, 'content-type':'application/json' },
    body: JSON.stringify({ token, scope: parsed }) });
  } catch { throw new Error('CANONICAL_WRITE_RECHECK_UNAVAILABLE'); }
  try { await response.body?.cancel(); } catch { throw new Error('CANONICAL_WRITE_RECHECK_UNAVAILABLE'); }
  if (response.status !== 204) throw new Error('CANONICAL_WRITE_RECHECK_DENIED');
 };
}
