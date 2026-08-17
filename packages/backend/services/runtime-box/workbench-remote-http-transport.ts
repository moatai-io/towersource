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
} from './workbench-remote-job-runner.js';

export interface RemoteWorkbenchHttpTransportOptions {
  workerId: string;
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

type WorkerEvent =
  | { type: 'stdout' | 'stderr'; chunk: string }
  | { type: 'result'; result: RemoteWorkbenchExecutionResult }
  | { type: 'error'; code: string; message: string };

/** Connect the common Remote Job runner to one preconfigured Worker endpoint. */
export function createRemoteWorkbenchHttpTransport(
  options: RemoteWorkbenchHttpTransportOptions,
): RemoteWorkbenchWorkerTransport {
  const request = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/$/, '')}/v1/runs`;
  return {
    workerId: options.workerId,
    async execute({ spec, credentials, signal, onStdout, onStderr }) {
      const response = await request(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ spec, ...(credentials ? { credentials } : {}) }),
        signal,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`REMOTE_WORKER_HTTP_${response.status}: Worker rejected the run`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      let result: RemoteWorkbenchExecutionResult | undefined;
      const handleLine = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line) as WorkerEvent;
        if (event.type === 'stdout') onStdout(event.chunk);
        else if (event.type === 'stderr') onStderr(event.chunk);
        else if (event.type === 'result') result = event.result;
        else if (event.type === 'error') throw new Error(`${event.code}: ${event.message}`);
      };

      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffered += decoder.decode(next.value, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      }
      buffered += decoder.decode();
      if (buffered.trim()) handleLine(buffered);
      if (!result) throw new Error('REMOTE_WORKER_PROTOCOL_ERROR: terminal result missing');
      return result;
    },
  };
}
