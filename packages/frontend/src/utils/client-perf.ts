// Owns: lightweight browser-side performance markers. Public API: perfNow, logClientPerf.
// Keep this dependency-free so startup instrumentation can import it safely.

type PerfFields = Record<string, unknown>;

export function perfNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

function perfLoggingEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem('tower:perf:client') === '1';
  } catch {
    return false;
  }
}

function sanitizePerfFields(fields: PerfFields): PerfFields {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => {
    if (/id$/i.test(key) && typeof value === 'string' && value.length > 12) {
      return [key, `${value.slice(0, 8)}…`];
    }
    return [key, value];
  }));
}

function elapsedFrom(fields: PerfFields): number {
  const value = fields.elapsedMs ?? fields.totalMs ?? fields.durationMs;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Log a compact client perf marker.
 *
 * Default behaviour is threshold-based to avoid noisy production consoles.
 * Operators can force all markers with:
 *   localStorage.setItem('tower:perf:client', '1')
 */
export function logClientPerf(label: string, fields: PerfFields = {}, options: { thresholdMs?: number } = {}): void {
  const thresholdMs = options.thresholdMs ?? 0;
  const elapsedMs = elapsedFrom(fields);
  if (!perfLoggingEnabled() && thresholdMs > 0 && elapsedMs < thresholdMs) return;
  if (typeof console === 'undefined' || typeof console.info !== 'function') return;
  // eslint-disable-next-line no-console
  console.info(`[perf][${label}]`, sanitizePerfFields(fields));
}
