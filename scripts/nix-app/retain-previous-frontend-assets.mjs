#!/usr/bin/env node
// Called under the deployment lock BEFORE the running server is stopped.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function frontendForEntrypoint(entrypoint, repoRoot) {
  if (entrypoint.endsWith('/launch')) return path.join(path.dirname(entrypoint), 'dist/frontend');
  if (entrypoint.endsWith('/bin/tower-app-start-production')) return path.resolve(path.dirname(entrypoint), '../lib/tower/dist/frontend');
  if (entrypoint.endsWith('/dist/backend/packages/backend/index.js')) return path.resolve(path.dirname(entrypoint), '../../../frontend');
  throw new Error('Cannot resolve previous frontend from deployment entrypoint');
}

export async function preserve({ entrypoint, release, dataDir, repoRoot }) {
  const helper = path.join(release, 'dist/backend/packages/backend/services/frontend-assets/retention.js');
  // Legacy releases predate this contract. Do not change their deployment behavior.
  if (!fs.existsSync(helper)) return { skipped: 'release predates asset retention' };
  const frontend = frontendForEntrypoint(entrypoint, repoRoot);
  if (!fs.existsSync(path.join(frontend, 'assets'))) throw new Error('Previous frontend assets unavailable; refusing cutover');
  const { retainFrontendAssets } = await import(pathToFileURL(helper).href);
  return { retained: retainFrontendAssets(frontend, dataDir) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [entrypoint, release, dataDir, repoRoot] = process.argv.slice(2);
  if (!entrypoint || !release || !dataDir || !repoRoot) throw new Error('usage: retain-previous-frontend-assets ENTRYPOINT RELEASE DATA_DIR REPO_ROOT');
  console.log(JSON.stringify(await preserve({ entrypoint, release, dataDir, repoRoot })));
}
