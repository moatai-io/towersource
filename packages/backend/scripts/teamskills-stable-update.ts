#!/usr/bin/env node
/** Run this JS from the deployed Tower app closure, not from ~/tower checkout. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTeamskillsProjectRoot } from '../services/skill/teamskills-source.js';
import { updateStableSkills, recoverStableSkills } from '../services/skill/stable-release-updater.js';
import { query } from '../db/pg-repo.js';
import { closePgPool } from '../db/pg.js';
import { selectStableUpdateProjectRoots } from '../services/skill/stable-update-targets.js';

const API = 'https://api.github.com/repos/juliuschun/teamskills/releases/latest';
const ASSETS = ['tower-skill-release.json', 'tower-skill-release.sig', 'tower-skills.tar.gz'];
const MAX = [8192, 1024, 32 * 1024 * 1024];
async function download(url: string, limit: number): Promise<Buffer> {
  const response = await fetch(url, { headers: { 'User-Agent': 'tower-teamskills-updater', Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) throw new Error(`download failed: ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) throw new Error('download limit exceeded');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
async function main(): Promise<void> {
  const entry = fs.realpathSync(fileURLToPath(import.meta.url));
  if (!entry.startsWith('/nix/store/') || !entry.includes('/lib/tower/dist/backend/packages/backend/scripts/teamskills-stable-update.js')) {
    throw new Error('run the updater from the immutable deployed app closure, not a mutable checkout');
  }
  const args = process.argv.slice(2);
  const modes = ['--check', '--apply', '--recover'].filter(flag => args.includes(flag));
  if (modes.length !== 1) throw new Error('exactly one of --check, --apply or --recover required');
  const mode = modes[0];
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${flag} required`);
    return args[index + 1];
  };
  const releasesRoot = path.resolve(value('--releases-root'));
  if (process.env.TEAMSKILLS_STABLE_RELEASES_ROOT !== releasesRoot) throw new Error('deployed service release root not configured to match updater');
  if (mode === '--recover') {
    if (args.length !== 3 || args[0] !== '--recover') throw new Error('recovery accepts only --recover --releases-root <root>');
    recoverStableSkills(getTeamskillsProjectRoot(), releasesRoot);
    console.log(JSON.stringify({ status: 'recovered' }));
    return;
  }
  const key = fs.readFileSync(value('--public-key'));
  const projects = args.flatMap((arg, i) => arg === '--project-root' ? [args[i + 1]] : []);
  const autoTargets = args.includes('--registered-projects');
  const recognized = new Set(['--check', '--apply', '--public-key', '--releases-root', '--project-root', '--registered-projects']);
  for (let i = 0; i < args.length; i++) {
    if (!recognized.has(args[i])) throw new Error('unknown argument');
    if (['--public-key', '--releases-root', '--project-root'].includes(args[i])) i++;
  }
  if (autoTargets && projects.length) throw new Error('choose --registered-projects or explicit --project-root, not both');
  if (!autoTargets && projects.length === 0) throw new Error('Project target selection required');
  // Both check and apply bind to the current DB snapshot; a timer picks up new
  // Projects on its next run instead of relying on a stale static list.
  const rows = await query<{ root_path: string | null }>('SELECT root_path FROM projects');
  const targetRoots = selectStableUpdateProjectRoots(rows, getTeamskillsProjectRoot(), autoTargets ? undefined : projects);
  const release = JSON.parse((await download(API, 64 * 1024)).toString('utf8')) as { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: Array<{ name: string; browser_download_url: string }> };
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name || '')) throw new Error('latest release is not stable');
  const assets = ASSETS.map((name, index) => {
    const matches = release.assets?.filter(asset => asset.name === name) ?? [];
    if (matches.length !== 1 || !matches[0].browser_download_url.startsWith(`https://github.com/juliuschun/teamskills/releases/download/${release.tag_name}/`)) throw new Error(`release asset missing or invalid: ${name}`);
    return download(matches[0].browser_download_url, MAX[index]);
  });
  const [descriptor, signature, archive] = await Promise.all(assets);
  const metadata = JSON.parse(descriptor.toString('utf8')) as { tag?: string };
  if (metadata.tag !== release.tag_name) throw new Error('release tag mismatch');
  const receipt = updateStableSkills({ mode: mode === '--apply' ? 'apply' : 'check', sourceRoot: getTeamskillsProjectRoot(), releasesRoot, projectRoots: targetRoots, input: { descriptor, signature, archive, publicKey: key } });
  console.log(JSON.stringify(receipt));
}
main().catch(err => { console.error(err instanceof Error ? err.message : 'stable update failed'); process.exitCode = 1; }).finally(() => closePgPool().catch(() => {}));
