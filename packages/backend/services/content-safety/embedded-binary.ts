// Owns: removing opaque embedded binary payloads from LLM-visible text while preserving surrounding source.
// Public API: sanitizeEmbeddedBinaryText. See README.md.

import crypto from 'node:crypto';

const MIN_OPAQUE_PAYLOAD_CHARS = 8 * 1024;
const DATA_URI_RE = /data:([\w.+-]+\/[\w.+-]+)(?:;[\w.+-]+=[^;,\s"']*)*;base64,([A-Za-z0-9+/=_-]+)/gi;
const LONG_BASE64_RE = /(?<![A-Za-z0-9+/=_-])([A-Za-z0-9+/=_-]{8192,})(?![A-Za-z0-9+/=_-])/g;

function omitted(label: string, payload: string): string {
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
  return `[embedded binary omitted: ${label}, encodedChars=${payload.length}, sha256=${sha256}]`;
}

/**
 * Replace large base64 data URIs and standalone base64-like runs in text.
 * The source file is never changed; only the representation sent to the LLM is reduced.
 */
export function sanitizeEmbeddedBinaryText(text: string): string {
  if (text.length < MIN_OPAQUE_PAYLOAD_CHARS) return text;

  const withoutDataUris = text.replace(DATA_URI_RE, (match, mimeType: string, payload: string) => {
    if (payload.length < MIN_OPAQUE_PAYLOAD_CHARS) return match;
    return `data:${mimeType};base64,${omitted(mimeType, payload)}`;
  });

  return withoutDataUris.replace(LONG_BASE64_RE, (payload: string) => omitted('base64', payload));
}
