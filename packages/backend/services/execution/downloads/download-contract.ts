import { DOWNLOAD_SCRIPT } from './download-script.js';
export const DOWNLOAD_TIMEOUT_MAX_SEC = 24 * 60 * 60;
export interface DownloadRequest {
  url: string; destination: string; expectedBytes?: number; sha256?: string; md5?: string;
  timeoutSec?: number; connectTimeoutSec?: number; idleTimeoutSec?: number; maxAttempts?: number;
}
/** Strict providers may require optional properties, represented as null. */
export function normalizeDownloadRequest(input: DownloadRequest): DownloadRequest {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null)) as unknown as DownloadRequest;
}
export function buildDownloadCommand(input: DownloadRequest): string {
  input = normalizeDownloadRequest(input);
  const url = new URL(input.url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('DOWNLOAD_REQUIRES_PUBLIC_HTTPS');
  // These URLs are persisted as command arguments. Signed/token-bearing URLs must use a separate credential-safe path.
  if (url.search || url.hash) throw new Error('DOWNLOAD_QUERY_URL_NOT_SUPPORTED');
  if (!/^[a-zA-Z0-9._/-]+$/.test(input.destination) || input.destination.startsWith('/') || input.destination.split('/').some(p => p === '..' || p === '') || input.destination.split('/').some(p => p === '.')) throw new Error('DOWNLOAD_DESTINATION_MUST_BE_PROJECT_RELATIVE');
  if (input.sha256 && !/^[a-fA-F0-9]{64}$/.test(input.sha256)) throw new Error('INVALID_SHA256');
  if (input.md5 && !/^[a-fA-F0-9]{32}$/.test(input.md5)) throw new Error('INVALID_MD5');
  if (input.sha256 && input.md5) throw new Error('SUPPLY_ONE_CHECKSUM');
  if (input.expectedBytes !== undefined && (!Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 0)) throw new Error('INVALID_EXPECTED_BYTES');
  const bounded = (value: number | undefined, fallback: number, max: number) => {
    const n = value ?? fallback;
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error('INVALID_DOWNLOAD_POLICY');
    return n;
  };
  bounded(input.timeoutSec, DOWNLOAD_TIMEOUT_MAX_SEC, DOWNLOAD_TIMEOUT_MAX_SEC);
  const config = { ...input, sha256: input.sha256?.toLowerCase(), md5: input.md5?.toLowerCase(), connectTimeoutSec: bounded(input.connectTimeoutSec,30,120), idleTimeoutSec: bounded(input.idleTimeoutSec,120,600), maxAttempts: bounded(input.maxAttempts,3,5) };
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  return `python3 -u -c ${quote(DOWNLOAD_SCRIPT)} ${quote(JSON.stringify(config))}`;
}
export interface DownloadProgress {
  phase: 'connecting' | 'transferring' | 'retry_wait' | 'verifying_resume' | 'verifying' | 'completed' | 'blocked';
  bytesReceived: number; bytesWritten: number; observedAt: number;
  lastByteAt?: number | null; lastDiskGrowthAt?: number | null;
  attempt: number; errorCode?: string | null; nextAction?: string | null;
  [key: string]: unknown;
}
export function latestDownloadProgress(output: string | null): DownloadProgress | undefined {
  for (const line of (output ?? '').split('\n').reverse()) {
    if (!line.startsWith('TOWER_DOWNLOAD_PROGRESS ')) continue;
    try {
      const p = JSON.parse(line.slice('TOWER_DOWNLOAD_PROGRESS '.length));
      if (['connecting','transferring','retry_wait','verifying_resume','verifying','completed','blocked'].includes(p.phase) && Number.isFinite(p.observedAt) && Number.isFinite(p.bytesWritten) && p.bytesWritten >= 0) return p;
    } catch { /* incomplete streaming line */ }
  }
  return undefined;
}

/** Only the exact managed script gets an extended deadline; arbitrary shell remains bounded. */
export function isManagedDownloadCommand(command: string): boolean {
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const prefix = `python3 -u -c ${quote(DOWNLOAD_SCRIPT)} `;
  if (!command.startsWith(prefix)) return false;
  const encoded = command.slice(prefix.length);
  if (!encoded.startsWith("'") || !encoded.endsWith("'")) return false;
  try {
    const input = JSON.parse(encoded.slice(1, -1).replaceAll("'\\''", "'"));
    return buildDownloadCommand(input) === command;
  } catch { return false; }
}
