export type LatestAttentionServerState = 'unread' | 'recently_read' | 'dismissed';

export type LatestAttentionServerEntry = {
  sessionId: string;
  sessionUpdatedAt?: string | null;
  state: LatestAttentionServerState;
};

type LatestAttentionState = {
  unreadSessionIds: string[];
  recentlyReadSessionUntil: Record<string, number>;
  updatedAt: number;
};

const ATTENTION_STORAGE_PREFIX = 'tower:latest-attention:v1';
const DISMISSED_STORAGE_PREFIX = 'tower:latest-dismissed-keys:v1';
const MAX_DISMISSED_KEYS = 1000;
const API_BASE = '/api';

function latestStateUserKey(): string {
  if (typeof localStorage === 'undefined') return 'anonymous';
  return localStorage.getItem('userId')
    || localStorage.getItem('username')
    || 'anonymous';
}

function storageKey(prefix: string): string {
  return `${prefix}:${latestStateUserKey()}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('token');
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function dismissedKeyToServerEntry(key: string): LatestAttentionServerEntry | null {
  const sep = key.indexOf(':');
  const sessionId = sep >= 0 ? key.slice(0, sep) : key;
  const sessionUpdatedAt = sep >= 0 ? key.slice(sep + 1) : null;
  if (!sessionId) return null;
  return { sessionId, sessionUpdatedAt, state: 'dismissed' };
}

let attentionSyncTimer: ReturnType<typeof setTimeout> | null = null;
let pendingAttentionPayload: { upsert: LatestAttentionServerEntry[]; delete: LatestAttentionServerEntry[] } = { upsert: [], delete: [] };

function enqueueServerAttentionSync(payload: { upsert?: LatestAttentionServerEntry[]; delete?: LatestAttentionServerEntry[] }): void {
  if (typeof fetch !== 'function' || typeof localStorage === 'undefined') return;
  pendingAttentionPayload = {
    upsert: [...pendingAttentionPayload.upsert, ...(payload.upsert || [])],
    delete: [...pendingAttentionPayload.delete, ...(payload.delete || [])],
  };
  if (attentionSyncTimer) clearTimeout(attentionSyncTimer);
  attentionSyncTimer = setTimeout(() => {
    const body = pendingAttentionPayload;
    pendingAttentionPayload = { upsert: [], delete: [] };
    attentionSyncTimer = null;
    fetch(`${API_BASE}/session-attention`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(body),
    }).catch(() => {});
  }, 150);
}

export async function loadLatestAttentionFromServer(): Promise<LatestAttentionServerEntry[]> {
  if (typeof fetch !== 'function' || typeof localStorage === 'undefined') return [];
  const res = await fetch(`${API_BASE}/session-attention`, { headers: authHeaders() });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.entries) ? data.entries : [];
}

export function applyServerLatestAttention(entries: LatestAttentionServerEntry[]): {
  unreadSessions: Set<string>;
  recentlyReadSessionUntil: Record<string, number>;
  dismissedKeys: Set<string>;
} {
  const unreadSessions = new Set<string>();
  const recentlyReadSessionUntil: Record<string, number> = {};
  const dismissedKeys = new Set<string>();

  for (const entry of entries) {
    if (!entry?.sessionId) continue;
    if (entry.state === 'unread') unreadSessions.add(entry.sessionId);
    if (entry.state === 'recently_read') recentlyReadSessionUntil[entry.sessionId] = 1;
    if (entry.state === 'dismissed') {
      dismissedKeys.add(entry.sessionUpdatedAt ? `${entry.sessionId}:${entry.sessionUpdatedAt}` : entry.sessionId);
    }
  }

  saveLatestAttentionState(unreadSessions, recentlyReadSessionUntil, { syncServer: false });
  saveDismissedLatestSessionKeys(dismissedKeys, { syncServer: false });
  window.dispatchEvent(new CustomEvent('tower:latest-dismissed-keys-updated', { detail: { keys: [...dismissedKeys] } }));
  return { unreadSessions, recentlyReadSessionUntil, dismissedKeys };
}

export function loadLatestAttentionState(): { unreadSessions: Set<string>; recentlyReadSessionUntil: Record<string, number> } {
  try {
    const raw = localStorage.getItem(storageKey(ATTENTION_STORAGE_PREFIX));
    if (!raw) return { unreadSessions: new Set(), recentlyReadSessionUntil: {} };
    const parsed = JSON.parse(raw) as Partial<LatestAttentionState>;
    const unreadSessionIds = Array.isArray(parsed.unreadSessionIds)
      ? parsed.unreadSessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    const recentlyReadSessionUntil: Record<string, number> = {};
    if (isPlainRecord(parsed.recentlyReadSessionUntil)) {
      for (const [id, value] of Object.entries(parsed.recentlyReadSessionUntil)) {
        if (typeof id === 'string' && typeof value === 'number' && Number.isFinite(value)) {
          recentlyReadSessionUntil[id] = value;
        }
      }
    }
    return { unreadSessions: new Set(unreadSessionIds), recentlyReadSessionUntil };
  } catch {
    return { unreadSessions: new Set(), recentlyReadSessionUntil: {} };
  }
}

export function saveLatestAttentionState(unreadSessions: Set<string>, recentlyReadSessionUntil: Record<string, number>, opts: { syncServer?: boolean } = {}): void {
  try {
    const payload: LatestAttentionState = {
      unreadSessionIds: [...unreadSessions],
      recentlyReadSessionUntil,
      updatedAt: Date.now(),
    };
    localStorage.setItem(storageKey(ATTENTION_STORAGE_PREFIX), JSON.stringify(payload));
    if (opts.syncServer !== false) {
      enqueueServerAttentionSync({
        upsert: [
          ...[...unreadSessions].map((sessionId) => ({ sessionId, sessionUpdatedAt: null, state: 'unread' as const })),
          ...Object.keys(recentlyReadSessionUntil).map((sessionId) => ({ sessionId, sessionUpdatedAt: null, state: 'recently_read' as const })),
        ],
        delete: Object.keys(recentlyReadSessionUntil).map((sessionId) => ({ sessionId, state: 'unread' as const })),
      });
    }
  } catch {}
}

/** Build the versioned key used to hide one session update from Latest. */
export function getLatestSessionDismissKey(session: { id: string; updatedAt: string }): string {
  return `${session.id}:${session.updatedAt}`;
}

/** A dismissed session stays hidden even while running; a later updatedAt creates a new visible update. */
export function isLatestSessionDismissed(keys: Set<string>, session: { id: string; updatedAt: string }): boolean {
  return keys.has(session.id) || keys.has(getLatestSessionDismissKey(session));
}

export function loadDismissedLatestSessionKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(DISMISSED_STORAGE_PREFIX));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string' && key.length > 0) : []);
  } catch {
    return new Set();
  }
}

export function saveDismissedLatestSessionKeys(keys: Set<string>, opts: { syncServer?: boolean } = {}): void {
  try {
    const values = [...keys].slice(-MAX_DISMISSED_KEYS);
    localStorage.setItem(storageKey(DISMISSED_STORAGE_PREFIX), JSON.stringify(values));
    if (opts.syncServer !== false) {
      enqueueServerAttentionSync({
        upsert: values.map(dismissedKeyToServerEntry).filter((entry): entry is LatestAttentionServerEntry => !!entry),
      });
    }
  } catch {}
}
