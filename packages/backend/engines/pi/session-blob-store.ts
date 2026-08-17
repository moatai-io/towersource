// Owns session-scoped binary payload policy helpers for Pi session logs.

export const PI_SESSION_INLINE_BINARY_WARN_BYTES = 512 * 1024;
// Real demo-org incidents accumulated 1.1–3.9MB PNGs; a 10MB per-item
// threshold did not protect the session context. Rehydration is lossy by
// contract, so keep at most sub-1MB images inline in the derived Pi JSONL.
export const PI_SESSION_INLINE_BINARY_EXTERNALIZE_BYTES = 1 * 1024 * 1024;
export const PI_SESSION_FILE_WARN_BYTES = 50 * 1024 * 1024;
export const PI_SESSION_FILE_CRITICAL_BYTES = 100 * 1024 * 1024;

export function isInlineBinaryExternalizationNeeded(byteLength: number): boolean {
  return byteLength >= PI_SESSION_INLINE_BINARY_EXTERNALIZE_BYTES;
}

export function shouldWarnInlineBinary(byteLength: number): boolean {
  return byteLength >= PI_SESSION_INLINE_BINARY_WARN_BYTES;
}

export function shouldWarnSessionFile(sizeBytes: number): boolean {
  return sizeBytes >= PI_SESSION_FILE_WARN_BYTES;
}

export function isSessionFileCritical(sizeBytes: number): boolean {
  return sizeBytes >= PI_SESSION_FILE_CRITICAL_BYTES;
}
