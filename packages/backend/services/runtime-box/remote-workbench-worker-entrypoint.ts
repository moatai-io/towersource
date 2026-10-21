/** @deprecated Worker process entrypoint is owned by services/execution/worker. */
export * from '../execution/worker/worker-entrypoint.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRemoteWorkbenchWorker } from '../execution/worker/worker-entrypoint.js';

// Preserve the installed legacy executable path until service definitions migrate.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startRemoteWorkbenchWorker();
}
