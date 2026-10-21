import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Fail closed before switching releases if the frontend build is stale/unknown. */
export function verifyFrontendRelease(frontendDir, expectedRevision) {
  if (!/^[a-f0-9]{40}$/.test(expectedRevision || '')) {
    throw new Error('frontend release: expected source revision must be a full SHA');
  }
  const metadata = JSON.parse(readFileSync(join(frontendDir, 'frontend-release.json'), 'utf8'));
  if (metadata.sourceRev !== expectedRevision) {
    throw new Error(`frontend release: source revision mismatch (expected ${expectedRevision}, got ${metadata.sourceRev || 'missing'})`);
  }
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    verifyFrontendRelease(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
