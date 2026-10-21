/** Internal signed Unix transport. Not a privileged listener or a peer-UID boundary.
 * Bootstrap owns socket directory permissions. Dispatch must honor abort and bound output.
 * Close times out explicitly if an adapter ignores cancellation; it does not claim cleanup.
 */
import net from 'node:net';
const LIMIT = 2 * 1024 * 1024;
const ERRORS = new Set([
  'LAUNCH_TRANSPORT_INVALID', 'LAUNCH_RESULT_LIMIT', 'LAUNCH_DISPATCH_FAILED',
  'LAUNCH_SIGNATURE_INVALID', 'LAUNCH_ENVELOPE_INVALID', 'LAUNCH_SCOPE_MISMATCH',
  'LAUNCH_ALREADY_CONSUMED', 'LAUNCH_CAPACITY_EXCEEDED', 'LAUNCH_PAYLOAD_INVALID',
  'LAUNCH_CREDENTIAL_LIMIT', 'LAUNCH_CANCELLED', 'LAUNCH_PREPARATION_FAILED',
  'LAUNCH_EXECUTION_FAILED', 'LAUNCH_CLEANUP_FAILED', 'LAUNCH_EXECUTION_AND_CLEANUP_FAILED',
  'WORKSTATION_COMMAND_POLICY_INVALID', 'WORKSTATION_COMMAND_PROJECT_MISMATCH',
  'WORKSTATION_CONTROLLER_IDENTITY_NOT_SEPARATED', 'WORKSTATION_LAUNCHER_IDENTITY_MISMATCH',
  'WORKSTATION_LAUNCHER_SUPPLEMENTARY_GROUPS_DENIED',
]);
type Request = { wire: string; signature: string };
interface Options { maxConnections?: number; maxDispatches?: number; frameDeadlineMs?: number; dispatchDeadlineMs?: number; closeDeadlineMs?: number; }
function bounded(value: number | undefined, fallback: number, maximum: number) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error('LAUNCH_TRANSPORT_CONFIG_INVALID');
  return result;
}
export function createWorkstationLaunchServer(dispatch: (request: Request, signal: AbortSignal) => Promise<unknown>, options: Options = {}) {
  const maxConnections = bounded(options.maxConnections, 16, 256);
  const maxDispatches = bounded(options.maxDispatches, 4, 64);
  const frameMs = bounded(options.frameDeadlineMs, 5000, 60000);
  const dispatchMs = bounded(options.dispatchDeadlineMs, 65000, 3660000);
  const closeMs = bounded(options.closeDeadlineMs, 5000, 60000);
  const active = new Set<net.Socket>();
  const pending = new Set<Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    if (closing || active.size >= maxConnections) { socket.destroy(); return; }
    active.add(socket);
    const abort = new AbortController();
    let buffer = Buffer.alloc(0), started = false;
    let dispatchTimer: ReturnType<typeof setTimeout> | undefined;
    const frameTimer = setTimeout(() => socket.destroy(), frameMs); // Absolute, not idle.
    socket.on('close', () => {
      clearTimeout(frameTimer); clearTimeout(dispatchTimer);
      active.delete(socket); abort.abort();
    });
    socket.on('data', data => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (started || buffer.length + chunk.length > LIMIT) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      started = true; clearTimeout(frameTimer);
      let request: Request;
      try {
        if (newline !== buffer.length - 1) throw new Error();
        const parsed = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
        if (!parsed || typeof parsed.wire !== 'string' || typeof parsed.signature !== 'string'
          || Object.keys(parsed).some(key => key !== 'wire' && key !== 'signature')) throw new Error();
        request = parsed;
      } catch { socket.end(JSON.stringify({ ok: false, error: 'LAUNCH_TRANSPORT_INVALID' }) + '\n'); return; }
      buffer = Buffer.alloc(0);
      if (pending.size >= maxDispatches) { socket.end(JSON.stringify({ ok: false, error: 'LAUNCH_CAPACITY_EXCEEDED' }) + '\n'); return; }
      dispatchTimer = setTimeout(() => { abort.abort(); socket.destroy(); }, dispatchMs);
      const task = (async () => {
        let response: string;
        try { response = JSON.stringify({ ok: true, result: await dispatch(request, abort.signal) }); }
        catch (error) {
          const message = error instanceof Error ? error.message : '';
          response = JSON.stringify({ ok: false, error: ERRORS.has(message) ? message : 'LAUNCH_DISPATCH_FAILED' });
        }
        if (Buffer.byteLength(response) > LIMIT - 1) response = JSON.stringify({ ok: false, error: 'LAUNCH_RESULT_LIMIT' });
        if (!socket.destroyed) socket.end(response + '\n');
      })();
      pending.add(task);
      void task.finally(() => { pending.delete(task); clearTimeout(dispatchTimer); }).catch(() => socket.destroy());
    });
  });
  return { server, close: (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('LAUNCH_CLOSE_TIMEOUT')), closeMs);
      for (const socket of active) socket.destroy();
      server.close(error => {
        void Promise.allSettled([...pending]).then(() => {
          clearTimeout(timer); if (error) reject(error); else resolve();
        });
      });
    });
    return closePromise;
  } };
}
export function executeWorkstationLaunch(socketPath: string, request: Request, signal: AbortSignal, timeoutMs = 65000): Promise<unknown> {
  if (signal.aborted) return Promise.reject(new Error('LAUNCH_CANCELLED'));
  bounded(timeoutMs, 65000, 3660000);
  const frame = JSON.stringify(request) + '\n';
  if (Buffer.byteLength(frame) > LIMIT) return Promise.reject(new Error('LAUNCH_TRANSPORT_LIMIT'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = Buffer.alloc(0), done = false;
    const timer = setTimeout(() => finish(new Error('LAUNCH_TRANSPORT_TIMEOUT')), timeoutMs);
    const finish = (error?: Error, result?: unknown) => {
      if (done) return; done = true;
      clearTimeout(timer); signal.removeEventListener('abort', cancel); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const cancel = () => finish(new Error('LAUNCH_CANCELLED'));
    // Install error/close handlers BEFORE any cancellation path can destroy the socket.
    socket.on('error', () => finish(new Error('LAUNCH_TRANSPORT_FAILED')));
    socket.on('close', () => finish(new Error('LAUNCH_TRANSPORT_CLOSED')));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    socket.on('connect', () => socket.write(frame));
    socket.on('data', data => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buffer.length + chunk.length > LIMIT) { finish(new Error('LAUNCH_RESULT_LIMIT')); return; }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline >= 0 && newline !== buffer.length - 1) finish(new Error('LAUNCH_RESPONSE_INVALID'));
    });
    // Wait for EOF: a later extra frame must not turn into an accepted first response.
    socket.on('end', () => {
      try {
        if (!buffer.length || buffer.indexOf(10) !== buffer.length - 1) throw new Error();
        const response = JSON.parse(buffer.subarray(0, -1).toString('utf8'));
        if (response?.ok === true && Object.keys(response).every(key => ['ok', 'result'].includes(key))) finish(undefined, response.result);
        else if (response?.ok === false && Object.keys(response).every(key => ['ok', 'error'].includes(key)) && ERRORS.has(response.error)) finish(new Error(response.error));
        else finish(new Error('LAUNCH_RESPONSE_INVALID'));
      } catch { finish(new Error('LAUNCH_RESPONSE_INVALID')); }
    });
  });
}
