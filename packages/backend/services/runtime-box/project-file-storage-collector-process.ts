import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { collectHostStorageSnapshot } from './project-file-storage-collector.js';
import type { StorageSnapshot } from './project-file-storage-preflight.js';

let activeScans = 0;
const MAX_CONCURRENT_SCANS = 2;

/** Execute the synchronous scan off the HTTP event loop with no inherited secrets. */
export function collectStorageSnapshotInProcess(
  input: Parameters<typeof collectHostStorageSnapshot>[0],
  options: { timeoutMs?: number } = {},
): Promise<StorageSnapshot> {
  const timeoutMs = options.timeoutMs ?? 25_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('STORAGE_COLLECTOR_TIMEOUT_INVALID');
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(new URL(`./project-file-storage-collector-entry.${source ? 'ts' : 'js'}`, import.meta.url));
  if (activeScans >= MAX_CONCURRENT_SCANS) throw new Error('STORAGE_COLLECTOR_BUSY');
  activeScans += 1;
  return new Promise<StorageSnapshot>((resolve, reject) => {
    // Development uses tsx; compiled distributions execute the emitted JS directly.
    const child = spawn(process.execPath, [...(source ? ['--import', 'tsx'] : []), entry], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { LANG: 'C.UTF-8', TZ: 'UTC' },
    });
    const chunks: Buffer[] = []; let bytes = 0; let failure: Error | undefined;
    const stop = (code: string) => { failure ??= new Error(code); child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('STORAGE_COLLECTOR_TIMEOUT'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) stop('STORAGE_COLLECTOR_OUTPUT_LIMIT');
      else chunks.push(chunk);
    });
    // Never forward raw subprocess exceptions or paths to clients/logs.
    child.stderr.resume();
    child.stdin.on('error', () => stop('STORAGE_COLLECTOR_INPUT_FAILED'));
    child.on('error', () => { failure ??= new Error('STORAGE_COLLECTOR_START_FAILED'); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error('STORAGE_COLLECTOR_SCAN_FAILED'));
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (result.projectId !== input.projectId || result.deploymentId !== input.deploymentId || result.complete !== true || !Array.isArray(result.entries)) throw new Error();
        resolve(result);
      } catch { reject(new Error('STORAGE_COLLECTOR_RESPONSE_INVALID')); }
    });
    child.stdin.end(JSON.stringify(input));
  }).finally(() => { activeScans -= 1; });
}
