#!/usr/bin/env node
/** Optional CHECK-ONLY scheduler entrypoint. Unattended apply is intentionally unsupported. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function run(): void {
  const entry = fs.realpathSync(fileURLToPath(import.meta.url));
  const prefix = '/lib/tower/dist/backend/packages/backend/scripts/';
  if (!entry.startsWith('/nix/store/') || !entry.endsWith(`${prefix}teamskills-stable-poll.js`)) throw new Error('immutable deployed app required');
  const cli = path.join(path.dirname(entry), 'teamskills-stable-update.js');
  if (fs.realpathSync(cli) !== cli) throw new Error('updater entrypoint unavailable');
  const releaseRoot = process.env.TEAMSKILLS_STABLE_RELEASES_ROOT;
  const key = process.env.TEAMSKILLS_STABLE_PUBLIC_KEY_PATH;
  if (!releaseRoot || !key || !path.isAbsolute(releaseRoot) || !path.isAbsolute(key)) throw new Error('polling not configured');
  // No mutation may be interrupted by this timeout. The update CLI's --check
  // uses only disposable temporary staging and cannot switch active metadata.
  // Never pass --apply here until durable crash recovery is designed and tested.
  const result = spawnSync(process.execPath, [cli, '--check', '--registered-projects', '--public-key', key, '--releases-root', releaseRoot], { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 });
  if (result.error || result.status !== 0) throw new Error('poll failed; retry at next scheduled run or inspect scoped logs');
  const receipt = JSON.parse(result.stdout.trim()) as { status: unknown; tag: unknown; archiveSha256: unknown; projects: unknown };
  if (receipt.status !== 'eligible' || !/^v\d+\.\d+\.\d+$/.test(String(receipt.tag))
    || !/^[a-f0-9]{64}$/.test(String(receipt.archiveSha256)) || !Number.isSafeInteger(receipt.projects)) throw new Error('invalid updater receipt');
  console.log(JSON.stringify({ status: receipt.status, tag: receipt.tag, archiveSha256: receipt.archiveSha256, projects: receipt.projects }));
}
try { run(); } catch (error) { console.error(error instanceof Error ? error.message : 'poll failed'); process.exitCode = 1; }
