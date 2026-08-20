// Owns: typed browser refs, drag codec, and inspect→confirm→execute client flow. See README.md.
import i18n from '../../i18n';

export const FILE_EXCHANGE_DRAG_TYPE = 'application/x-tower-file-exchange';

export type ExchangeSourceRef =
  | { scope: 'personal'; uri: string }
  | { scope: 'session'; sessionId: string; attachmentId: string }
  | { scope: 'channel'; channelId: string; fileId: string }
  | { scope: 'project'; projectId: string; relativePath: string };

export type ExchangeDestinationRef =
  | { scope: 'personal'; relativeDirectory?: string }
  | { scope: 'session'; sessionId: string }
  | { scope: 'channel'; channelId: string }
  | { scope: 'project'; projectId: string; relativeDirectory?: string };

export interface ExchangeDragPayload {
  version: 1;
  source: ExchangeSourceRef;
  name: string;
  sizeBytes?: number;
  mimeType?: string | null;
}

export interface ExchangePlan {
  id: string;
  source: ExchangeSourceRef;
  destination: ExchangeDestinationRef;
  mode: 'snapshot' | 'workspace_copy';
  sourceName: string;
  sourceMimeType: string | null;
  sourceSizeBytes: number;
  confirmationRequired: boolean;
  confirmationMessage: string | null;
  expiresAt: string;
}

export interface ExchangeReceipt {
  id: string;
  planId: string;
  status: 'completed' | 'failed' | 'denied' | 'stale';
  result: Record<string, unknown> | null;
  failureCode: string | null;
  failureStage: string | null;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || i18n.t('fileExchange.transferFailed', { ns: 'files' }));
  return data as T;
}

/** Encode only opaque storage refs; never include host paths or file content. */
export function encodeExchangeDrag(payload: ExchangeDragPayload): string {
  return JSON.stringify(payload);
}

/** Decode a versioned File Exchange drag payload and reject legacy/raw-path shapes. */
export function decodeExchangeDrag(raw: string): ExchangeDragPayload | null {
  try {
    const value = JSON.parse(raw) as ExchangeDragPayload;
    if (value?.version !== 1 || !value.name || !value.source?.scope) return null;
    if (!['personal', 'session', 'channel', 'project'].includes(value.source.scope)) return null;
    return value;
  } catch { return null; }
}

/** Ask the server to author a short-lived plan after provider ACL checks. */
export function inspectExchange(source: ExchangeSourceRef, destination: ExchangeDestinationRef): Promise<ExchangePlan> {
  return jsonRequest('/api/file-exchange/inspect', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, destination }),
  });
}

/** Bind an authenticated browser confirmation to one exact pending plan. */
export function confirmExchange(planId: string): Promise<{ ok: true; planId: string }> {
  return jsonRequest('/api/file-exchange/confirm', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ planId }),
  });
}

/** Execute a server-authored plan. Confirmation, when required, must already be server-recorded. */
export function executeExchange(planId: string): Promise<ExchangeReceipt> {
  return jsonRequest('/api/file-exchange/execute', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ planId }),
  });
}

/** Complete an exchange with a caller-supplied confirmation UI. */
export async function transferFile(
  source: ExchangeSourceRef,
  destination: ExchangeDestinationRef,
  confirm: (plan: ExchangePlan) => Promise<boolean>,
): Promise<ExchangeReceipt | null> {
  const plan = await inspectExchange(source, destination);
  const approved = !plan.confirmationRequired || await confirm(plan);
  if (!approved) return null;
  if (plan.confirmationRequired) await confirmExchange(plan.id);
  return executeExchange(plan.id);
}
