import type { PoolClient } from 'pg';
import { getPgPool, isPgEnabled } from '../db/pg.js';

const WS_SYNC_CHANNEL = 'tower_ws_events';

export type WsSyncEnvelope =
  | { origin: string; scope: 'all'; data: any }
  | { origin: string; scope: 'session'; sessionId: string; data: any }
  | { origin: string; scope: 'user'; userId: number; data: any };

export type OutboundWsSyncEnvelope =
  | { scope: 'all'; data: any }
  | { scope: 'session'; sessionId: string; data: any }
  | { scope: 'user'; userId: number; data: any };

export interface WsSyncHandlers {
  all(data: any): void;
  session(sessionId: string, data: any): void;
  user(userId: number, data: any): void;
}

let listenerClient: PoolClient | null = null;
let registeredHandlers: WsSyncHandlers | null = null;
let registeredOrigin: string | null = null;

export function parseWsSyncPayload(payload: string): WsSyncEnvelope | null {
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.origin !== 'string') return null;
    if (!['all', 'session', 'user'].includes(parsed.scope)) return null;
    if (!('data' in parsed)) return null;
    return parsed as WsSyncEnvelope;
  } catch {
    return null;
  }
}

export function dispatchWsSyncEnvelope(
  envelope: WsSyncEnvelope,
  localOrigin: string,
  handlers: WsSyncHandlers,
): void {
  if (envelope.origin === localOrigin) return;

  switch (envelope.scope) {
    case 'all':
      handlers.all(envelope.data);
      return;
    case 'session':
      if (typeof envelope.sessionId === 'string' && envelope.sessionId) {
        handlers.session(envelope.sessionId, envelope.data);
      }
      return;
    case 'user':
      if (typeof envelope.userId === 'number' && Number.isFinite(envelope.userId)) {
        handlers.user(envelope.userId, envelope.data);
      }
      return;
  }
}

export async function initWsSync(origin: string, handlers: WsSyncHandlers): Promise<void> {
  registeredOrigin = origin;
  registeredHandlers = handlers;

  if (!isPgEnabled()) return;
  if (listenerClient) return;

  let acquiredClient: PoolClient | null = null;
  try {
    const client = await getPgPool().connect();
    acquiredClient = client;
    await client.query(`LISTEN ${WS_SYNC_CHANNEL}`);
    client.on('notification', (msg) => {
      if (msg.channel !== WS_SYNC_CHANNEL || !msg.payload || !registeredHandlers || !registeredOrigin) return;
      const envelope = parseWsSyncPayload(msg.payload);
      if (!envelope) return;
      dispatchWsSyncEnvelope(envelope, registeredOrigin, registeredHandlers);
    });
    client.on('error', (err) => {
      console.error('[ws-sync] listener error:', err.message);
    });
    listenerClient = client;
    console.log(`[ws-sync] LISTEN ${WS_SYNC_CHANNEL}`);
  } catch (err: any) {
    console.error('[ws-sync] init failed:', err.message || err);
    // LISTEN can fail before listenerClient is assigned. Discard the acquired
    // connection: subscription state may be uncertain after a lost response.
    try { acquiredClient?.release(true); } catch {}
    listenerClient = null;
  }
}

export async function stopWsSync(): Promise<void> {
  if (!listenerClient) return;
  try {
    await listenerClient.query(`UNLISTEN ${WS_SYNC_CHANNEL}`);
  } catch {}
  try {
    listenerClient.release();
  } catch {}
  listenerClient = null;
}

// PostgreSQL `pg_notify` payload hard limit is 8000 bytes (UTF-8).
// We cap at 7500 bytes to leave headroom for protocol overhead.
// NOTE: the check MUST be on UTF-8 byte length, not JS code-unit length —
//       a 7600-char string of Korean / tool_use JSON can be >15 KB in UTF-8,
//       which previously triggered "publish failed: payload string too long"
//       on the server side and bypassed callers' oversize fallbacks.
const PG_NOTIFY_SAFE_PAYLOAD_BYTES = 7500;

// Throttle repeated "skip oversized" warnings to 1/min per origin to avoid
// flooding logs when a large streaming message emits many chunks.
let lastOversizeWarnAt = 0;
const OVERSIZE_WARN_INTERVAL_MS = 60_000;

export function publishWsSyncEvent(origin: string, envelope: OutboundWsSyncEnvelope): boolean {
  if (!isPgEnabled()) return false;
  const payload = JSON.stringify({ origin, ...envelope });
  const byteLen = Buffer.byteLength(payload, 'utf8');
  if (byteLen > PG_NOTIFY_SAFE_PAYLOAD_BYTES) {
    const now = Date.now();
    if (now - lastOversizeWarnAt > OVERSIZE_WARN_INTERVAL_MS) {
      console.warn(`[ws-sync] skip oversized payload (${byteLen} bytes, ${payload.length} chars, scope=${envelope.scope})`);
      lastOversizeWarnAt = now;
    }
    return false;
  }
  getPgPool()
    .query('SELECT pg_notify($1, $2)', [WS_SYNC_CHANNEL, payload])
    .catch((err) => {
      console.error('[ws-sync] publish failed:', err.message || err);
    });
  return true;
}
