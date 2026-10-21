/** Internal subprocess entry, not an HTTP API. Parent owns authorization. */
import { collectHostStorageSnapshot } from './project-file-storage-collector.js';
try {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16_384) throw new Error('INPUT_LIMIT');
    chunks.push(Buffer.from(chunk));
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  process.stdout.write(JSON.stringify(collectHostStorageSnapshot(input)));
} catch {
  process.exitCode = 1;
}
