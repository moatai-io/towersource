// Read-only, bounded per-turn SpendLogs client. This contract is not wired into
// turn completion until the Router exposes and verifies the matching endpoint.
import { resolveLiteLLMCredentials } from '../ai/litellm-credentials.js';
import type { RouterSpendRow } from './turn-spend-reconciliation.js';

const MAX_ROWS = 500;

/** The Router must derive key/team scope from the bearer virtual key, never from caller query params. */
export async function fetchLiteLLMTurnSpend(rootTurnId: string, signal?: AbortSignal): Promise<RouterSpendRow[]> {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(rootTurnId)) throw new Error('invalid root turn id');
  const { baseUrl, apiKey } = await resolveLiteLLMCredentials();
  const routerBase = (process.env.LITELLM_USAGE_BASE_URL?.trim() || baseUrl.replace(/\/v1\/?$/, '') + '/usage-self-service').replace(/\/$/, '');
  const url = new URL(`${routerBase}/v1/turn-spend`);
  url.searchParams.set('root_turn_id', rootTurnId);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: signal ?? AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`LiteLLM turn spend unavailable: HTTP ${response.status}`);
  // A bounded row count alone does not bound an untrusted response body.
  // Read at most 256 KiB before parsing, including when Content-Length is absent.
  const maxBytes = 256 * 1024;
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('turn spend response too large');
  if (!response.body) throw new Error('invalid turn spend response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('turn spend response too large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bodyBytes = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { bodyBytes.set(chunk, offset); offset += chunk.byteLength; }
  let data: unknown;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes)); }
  catch { throw new Error('invalid turn spend response'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid turn spend response');
  const body = data as Record<string, unknown>;
  // A 200 response is not proof that all rows arrived. Require an explicit
  // exhaustive result; missing/truncated pagination must never confirm spend.
  if (body.source !== 'litellm-spendlogs' || body.root_turn_id !== rootTurnId
    || body.complete !== true || !Array.isArray(body.rows) || body.rows.length > MAX_ROWS) {
    throw new Error('invalid turn spend scope or row limit');
  }
  const result:RouterSpendRow[]=[];const seen=new Set<string>();
  for(const row of body.rows){
    if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('invalid turn spend row');
    const r=row as Record<string,unknown>,snake='request_id' in r||'root_turn_id' in r;
    if(snake&&('requestId' in r||'rootTurnId' in r))throw new Error('ambiguous turn spend row');
    const requestId=snake?r.request_id:r.requestId,root=snake?r.root_turn_id:r.rootTurnId;
    if(typeof requestId!=='string'||!/^[-A-Za-z0-9_:./=+]{1,2048}$/.test(requestId)||seen.has(requestId)||root!==rootTurnId||r.status!=='success'||typeof r.spend!=='string'||!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(r.spend))throw new Error('invalid turn spend row');
    seen.add(requestId);result.push({requestId,rootTurnId,spend:r.spend,status:'success'});
  }
  return result;
}
