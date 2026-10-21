// Owns: lightweight browser-side performance markers. Public API: perfNow, logClientPerf.
// Keep this dependency-free so startup instrumentation can import it safely.

type PerfFields = Record<string, unknown>;

type PerfTrace = {
  id: number;
  label: string;
  startedAt: number;
  lastMarkAt: number;
  fields: PerfFields;
};

const MAX_ACTIVE_TRACES = 20;
const activeTraces = new Map<string, PerfTrace>();
let nextTraceId = 1;

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

function traceKey(label: string, key: string): string {
  return `${label}:${key}`;
}

function performanceMark(name: string): void {
  try { performance?.mark?.(name); } catch {}
}

function performanceMeasure(name: string, startMark: string, endMark: string): void {
  try { performance?.measure?.(name, startMark, endMark); } catch {}
}

/** Start one bounded user-flow trace. Starting the same label/key replaces a stale trace. */
export function startClientPerfTrace(label: string, key: string, fields: PerfFields = {}): void {
  const now = perfNow();
  const trace: PerfTrace = { id: nextTraceId++, label, startedAt: now, lastMarkAt: now, fields: { ...fields } };
  const keyForTrace = traceKey(label, key);
  activeTraces.delete(keyForTrace);
  activeTraces.set(keyForTrace, trace);
  while (activeTraces.size > MAX_ACTIVE_TRACES) {
    const oldestKey = activeTraces.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    activeTraces.delete(oldestKey);
  }
  performanceMark(`tower:${label}:${trace.id}:start`);
}

/** Record a phase duration and cumulative elapsed time without logging intermediate noise. */
export function markClientPerfTrace(label: string, key: string, phase: string, fields: PerfFields = {}): void {
  const trace = activeTraces.get(traceKey(label, key));
  if (!trace) return;
  const now = perfNow();
  const phaseMark = `tower:${label}:${trace.id}:${phase}`;
  performanceMark(phaseMark);
  performanceMeasure(`${phaseMark}:duration`, `tower:${label}:${trace.id}:start`, phaseMark);
  trace.fields = {
    ...trace.fields,
    ...fields,
    [`${phase}Ms`]: Math.round(now - trace.lastMarkAt),
    [`${phase}ElapsedMs`]: Math.round(now - trace.startedAt),
  };
  trace.lastMarkAt = now;
}

/** Finish and log a trace. Returns false when no matching trace is active. */
export function finishClientPerfTrace(
  label: string,
  key: string,
  fields: PerfFields = {},
  options: { thresholdMs?: number } = {},
): boolean {
  const mapKey = traceKey(label, key);
  const trace = activeTraces.get(mapKey);
  if (!trace) return false;
  activeTraces.delete(mapKey);
  const now = perfNow();
  const endMark = `tower:${label}:${trace.id}:end`;
  performanceMark(endMark);
  performanceMeasure(`tower:${label}:${trace.id}:total`, `tower:${label}:${trace.id}:start`, endMark);
  const completedFields = {
    ...trace.fields,
    ...fields,
    elapsedMs: Math.round(now - trace.startedAt),
  };
  logClientPerf(label, completedFields, options);
  try {
    window?.dispatchEvent?.(new CustomEvent('tower:client-perf', {
      detail: { label, fields: sanitizePerfFields(completedFields) },
    }));
  } catch {}
  return true;
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
