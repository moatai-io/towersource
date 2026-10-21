// Owns: typed browser refs and the versioned drag codec. See README.md.

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
  } catch {
    return null;
  }
}
