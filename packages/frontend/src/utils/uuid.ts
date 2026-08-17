/**
 * Secure-context-safe UUID v4 generator.
 *
 * `crypto.randomUUID()` is only available in Secure Contexts (HTTPS or localhost).
 * When accessing via HTTP + IP address (e.g. http://192.168.x.x), the browser
 * treats it as an insecure context and `crypto.randomUUID` is undefined.
 *
 * This helper falls back to `crypto.getRandomValues()` which works everywhere.
 */
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: RFC 4122 v4 UUID via getRandomValues (works in all contexts)
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16),
  );
}
