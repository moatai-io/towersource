import fs from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  compareAndSwapCanonicalProjectText,
  MAX_CANONICAL_WORKSPACE_TEXT_BYTES,
  readCanonicalProjectFileBytes,
  writeCanonicalProjectText,
} from '../project-environment/adapters/canonical-host-file-adapter.js';

export const MAX_WORKER_TEXT_WRITE_BYTES = 100 * 1024 * 1024;
export type WorkerTextWriteMode = 'exclusive' | 'replace' | 'cas';

/** Bounded raw-body text transfer, not execution JSON. Publication reuses a shared fd-anchored staging writer for normal and CAS
 * writes. Atomic publication is not transaction-wide authorization or writer locking.
 * Staging is private and removed on success, conflict, invalid UTF-8 or disconnect.
 */
export async function receiveWorkerProjectTextWrite(input: {
  projectRoot: string;
  relativePath: string;
  mode: WorkerTextWriteMode;
  expectedSha256?: string;
  /** Verified signed body digest, when invoked through canonical delegation. */
  expectedBodySha256?: string;
  /** Revalidate delegated authority after staging, before synchronous publication. */
  beforePublish?: () => Promise<void>;
  expectedBytes: number;
  chunks: AsyncIterable<Uint8Array | string>;
}): Promise<number> {
  const limit = input.mode === 'cas' ? MAX_CANONICAL_WORKSPACE_TEXT_BYTES : MAX_WORKER_TEXT_WRITE_BYTES;
  if (!Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 0 || input.expectedBytes > limit) {
    throw new Error('WORKER_TEXT_WRITE_SIZE_LIMIT');
  }
  if (input.mode === 'cas' && !/^[a-f0-9]{64}$/.test(input.expectedSha256 || '')) throw new Error('WORKER_TEXT_CAS_HASH_INVALID');
  // Detect replacement across asynchronous upload/authority waits. The final
  // writer still owns fd traversal; this is not an atomic rename/authorization lease.
  const rootIdentity = lstatSync(input.projectRoot, { bigint: true });
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) throw new Error('WORKER_TEXT_WRITE_ROOT_INVALID');
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-worker-text-'));
  const temporary = path.join(staging, 'body');
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    let size = 0;
    try {
      for await (const chunk of input.chunks) {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
        size += bytes.length;
        if (size > input.expectedBytes || size > limit) throw new Error('WORKER_TEXT_WRITE_SIZE_LIMIT');
        await handle.writeFile(bytes);
      }
    } finally { await handle.close(); }
    if (size !== input.expectedBytes) throw new Error('WORKER_TEXT_WRITE_LENGTH_MISMATCH');
    const bytes = await fs.readFile(temporary);
    if (input.expectedBodySha256 !== undefined && createHash('sha256').update(bytes).digest('hex') !== input.expectedBodySha256) {
      throw new Error('WORKER_TEXT_WRITE_BODY_MISMATCH');
    }
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    await input.beforePublish?.();
    const currentRoot = lstatSync(input.projectRoot, { bigint: true });
    if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink()
      || currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino) {
      throw new Error('WORKER_TEXT_WRITE_ROOT_CHANGED');
    }
    if (input.mode === 'cas') {
      const current = readCanonicalProjectFileBytes(input.projectRoot, input.relativePath, MAX_CANONICAL_WORKSPACE_TEXT_BYTES);
      if (createHash('sha256').update(current).digest('hex') !== input.expectedSha256) throw new Error('SCOPED_EDIT_STALE_SOURCE');
      // The final comparison and replacement recheck current contents and inode.
      compareAndSwapCanonicalProjectText(input.projectRoot, input.relativePath, current.toString('utf8'), content);
    } else {
      writeCanonicalProjectText(input.projectRoot, input.relativePath, content, input.mode === 'exclusive');
    }
    return size;
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
