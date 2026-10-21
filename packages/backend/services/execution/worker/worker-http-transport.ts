/**
 * Owns: HTTP NDJSON transport from Tower to one allowlisted Remote Workbench Worker.
 * Public API: createRemoteWorkbenchHttpTransport.
 *
 * The bearer token is transport configuration only. It is never included in Job specs,
 * durable rows, output, or errors returned by this module.
 */

import type {
  RemoteWorkbenchExecutionResult,
  RemoteWorkbenchWorkerTransport,
} from '../remote-job-runner.js';
import { issueWorkbenchAuthorizationReceipt } from '../../runtime-box/workbench-authorization-receipt.js';
import { issueWorkbenchProjectExecutionGrant, type WorkbenchTeamExecutionScope } from '../../runtime-box/workbench-project-execution-grant.js';

export interface RemoteWorkbenchHttpTransportOptions {
  workerId: string;
  baseUrl: string;
  token: string;
  /** DB-authoritative Project root. When present, issue a short-lived execution grant. */
  projectRoot?: string;
  /** Trusted server context only, never derived from arbitrary Job spec fields.
   * The upper dispatch layer owns fresh actor/team/storage authorization for
   * each run. Signing this intent is not Worker capability or mount enforcement.
   */
  teamScope?: WorkbenchTeamExecutionScope;
  /** Safe GET-only grace used after stale heartbeat selection; the run POST is still sent once. */
  readinessGraceMs?: number;
  readinessPollMs?: number;
  fetchImpl?: typeof fetch;
}

class WorkerProtocolError extends Error {
  constructor(detail: string) { super(`REMOTE_WORKER_PROTOCOL_ERROR: ${detail}; completion unknown — inspect effects before retry`); }
}
function isExecutionResult(value: any): value is RemoteWorkbenchExecutionResult {
  const exec = value?.execResult;
  return !!exec && Number.isInteger(exec.exit_code) && typeof exec.stdout === 'string'
    && typeof exec.stderr === 'string' && Number.isFinite(exec.duration_ms)
    && typeof exec.timed_out === 'boolean' && typeof exec.oom_killed === 'boolean'
    && typeof exec.runtime_context === 'object' && exec.runtime_context !== null && Array.isArray(value.artifacts);
}
function isExplicitCancellation(error: unknown): error is Error {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

type WorkerEvent =
  | { type: 'stdout' | 'stderr'; chunk: string }
  | { type: 'result'; result: RemoteWorkbenchExecutionResult }
  | { type: 'error'; code: string; message: string };

function transportDetail(error: unknown): string {
  const cause = error instanceof Error && 'cause' in error ? error.cause : undefined;
  const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
    ? cause.code : undefined;
  // Do not expose arbitrary error messages: fetch failures may contain URLs or headers.
  return code && /^[A-Z][A-Z0-9_]{1,80}$/.test(code) ? code : 'transport error';
}

function workerDispatchError(workerId: string, error: unknown, elapsedMs: number): Error {
  if (isExplicitCancellation(error)) return error;
  const detail = transportDetail(error);
  const phase = detail === 'UND_ERR_HEADERS_TIMEOUT' ? 'waiting for response headers' : 'before response headers';
  return new Error(`WORKER_UNREACHABLE: ${workerId}; dispatch failed (${detail}); phase=${phase}; elapsedMs=${elapsedMs}; POST outcome unknown — inspect effects before retry`);
}

function waitForPoll(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
    };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForWorkerReadiness(options: RemoteWorkbenchHttpTransportOptions, request: typeof fetch, signal: AbortSignal): Promise<void> {
  const graceMs = Math.min(Math.max(Math.trunc(options.readinessGraceMs ?? 0), 0), 30_000);
  if (graceMs === 0) return;
  const pollMs = Math.min(Math.max(Math.trunc(options.readinessPollMs ?? 250), 25), 2_000);
  const deadline = Date.now() + graceMs;
  let lastDetail = 'readiness grace expired';
  do {
    try {
      const response = await request(`${options.baseUrl.replace(/\/$/, '')}/ready`, { signal });
      if (response.ok) {
        const body = await response.json().catch(() => null) as { workerId?: unknown; ok?: unknown } | null;
        if (body?.workerId === options.workerId && body.ok === true) return;
        lastDetail = 'readiness identity mismatch';
      } else lastDetail = `readiness HTTP ${response.status}`;
    } catch (error) {
      if (signal.aborted || isExplicitCancellation(error)) throw error;
      lastDetail = transportDetail(error);
    }
    if (Date.now() >= deadline) break;
    await waitForPoll(Math.min(pollMs, Math.max(deadline - Date.now(), 0)), signal);
  } while (Date.now() <= deadline);
  throw new Error(`WORKER_UNREACHABLE: ${options.workerId}; readiness not restored (${lastDetail})`);
}

/** Connect the common Remote Job runner to one preconfigured Worker endpoint. */
export function createRemoteWorkbenchHttpTransport(
  options: RemoteWorkbenchHttpTransportOptions,
): RemoteWorkbenchWorkerTransport {
  const request = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/$/, '')}/v1/runs`;
  return {
    workerId: options.workerId,
    async execute({ spec, credentials, authorizationReceipt, signal, onStdout, onStderr }) {
      if (signal.aborted) throw signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
      const receipt = authorizationReceipt ?? issueWorkbenchAuthorizationReceipt({
        secret: options.token,
        actorUserId: spec.actorUserId,
        projectId: spec.projectId,
        sessionId: spec.sessionId ?? 'system',
        jobId: spec.jobId,
        environmentKeys: spec.environmentKeys,
      });
      // Fail before readiness/dispatch rather than transmitting unsigned scope.
      if (options.teamScope !== undefined && !options.projectRoot) throw new Error('TEAM_EXECUTION_SCOPE_PROJECT_ROOT_REQUIRED');
      const executionGrant = options.projectRoot ? issueWorkbenchProjectExecutionGrant({
        secret: options.token,
        workerId: options.workerId,
        projectRoot: options.projectRoot,
        spec,
        teamScope: options.teamScope,
      }) : undefined;
      await waitForWorkerReadiness(options, request, signal);
      let response: Response;
      const dispatchStartedAt = Date.now();
      try {
        response = await request(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ spec, authorizationReceipt: receipt, ...(executionGrant ? { executionGrant } : {}), ...(credentials ? { credentials } : {}) }),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw workerDispatchError(options.workerId, error, Math.max(0, Date.now() - dispatchStartedAt));
      }
      if (!response.ok || !response.body) {
        let detail = '';
        if (response.body) {
          try {
            const raw = await response.text();
            const first = raw.split('\n').find(line => line.trim());
            if (first) {
              const event = JSON.parse(first) as Partial<Extract<WorkerEvent, { type: 'error' }>>;
              if (event.code && event.message) detail = `${event.code}: ${event.message}`;
            }
          } catch (error) {
            if (signal.aborted || isExplicitCancellation(error)) throw error;
            // Preserve the bounded HTTP error when a legacy Worker sends no structured body.
          }
        }
        throw new Error(`REMOTE_WORKER_HTTP_${response.status}: ${detail || 'Worker rejected the run'}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      let result: RemoteWorkbenchExecutionResult | undefined;
      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let event: WorkerEvent;
        try { event = JSON.parse(line) as WorkerEvent; }
        catch { throw new WorkerProtocolError('invalid NDJSON event'); }
        if (!event || typeof event !== 'object') throw new WorkerProtocolError('invalid event shape');
        if (result) throw new WorkerProtocolError('event after terminal result');
        if (event.type === 'stdout' || event.type === 'stderr') {
          if (typeof event.chunk !== 'string') throw new WorkerProtocolError('invalid output chunk');
          // Callback failures are local, never classified as Worker connectivity errors.
          if (event.type === 'stdout') onStdout(event.chunk); else onStderr(event.chunk);
        } else if (event.type === 'result') {
          if (!isExecutionResult(event.result)) throw new WorkerProtocolError('invalid terminal result');
          result = event.result;
        } else if (event.type === 'error') {
          if (typeof event.code !== 'string' || !/^[A-Z][A-Z0-9_]+$/.test(event.code) || typeof event.message !== 'string') {
            throw new WorkerProtocolError('invalid error event');
          }
          throw new Error(`${event.code}: ${event.message}`);
        } else throw new WorkerProtocolError('unknown event type');
      };
      try {
        while (true) {
          let next: ReadableStreamReadResult<Uint8Array>;
          try { next = await reader.read(); }
          catch (error) {
            if (signal.aborted || isExplicitCancellation(error)) throw error;
            throw new Error(`WORKER_RESPONSE_INTERRUPTED: ${options.workerId}; response body interrupted (${transportDetail(error)}); response headers received, completion unknown — inspect effects before retry`);
          }
          if (next.done) break;
          buffered += decoder.decode(next.value, { stream: true });
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';
          for (const line of lines) handleLine(line);
        }
        buffered += decoder.decode();
        if (buffered.trim()) handleLine(buffered);
        if (!result) throw new WorkerProtocolError('terminal result missing');
        return result;
      } finally {
        // Bound resource lifetime after explicit/protocol/callback errors, too.
        try { await reader.cancel(); } catch { /* Keep the primary error. */ }
        reader.releaseLock();
      }
    },
  };
}
