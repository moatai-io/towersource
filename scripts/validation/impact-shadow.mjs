import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { impactPolicy } from './impact-policy.mjs';
import { discoverRelated } from './discover-related.mjs';
import { pathToFileURL } from 'node:url';

// Advisory inventory only. Never returns a validation attestation or executes tests.
export function compareSelection({ root, changedPaths, selectedFiles, testFiles, read }) {
  const selected = new Set(selectedFiles.map(file => path.relative(root, path.resolve(root, file)).split(path.sep).join('/')));
  const textLinked = [];
  for (const file of testFiles) {
    const source = read(file);
    const matches = changedPaths.filter(changed => source.includes(changed));
    if (matches.length) textLinked.push({ file, changedPaths: matches, selected: selected.has(file) });
  }
  return { mode: 'shadow-only', changedPaths, selectedCount: selected.size, discoveredTests: testFiles.length, textLinked, unselectedTextLinks: textLinked.filter(link => !link.selected), warning: 'Text matching is incomplete and may be coincidental. Missing links are review candidates, not proven false negatives. No tests were skipped or executed.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw Error('usage: impact-shadow.mjs <base-commit>');
  const root = process.cwd();
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 60_000 });
    if (result.status !== 0 || result.error) throw Error(`Shadow discovery failed: ${command} (no validation policy changed)`);
    return result.stdout;
  };
  const base = run('git', ['rev-parse', '--verify', `${process.argv[2]}^{commit}`]).trim();
  const changedPaths = [...new Set([
    ...run('git', ['diff', '--no-renames', '--name-only', base, '--']).trim().split('\n'),
    ...run('git', ['ls-files', '--others', '--exclude-standard']).trim().split('\n'),
  ].filter(Boolean))];
  const changes = run('git', ['diff', '--no-renames', '--name-status', '-z', base, '--']).split('\0').filter(Boolean);
  const statuses = new Map();
  for (let i = 0; i < changes.length; i += 2) statuses.set(changes[i + 1], changes[i]);
  const policyChanges = changedPaths.map(file => ({ path: file, status: statuses.get(file) || 'A' }));
  let discoveryError = false;
  let selectedFiles = [];
  try { selectedFiles = await discoverRelated(changedPaths); }
  catch { discoveryError = true; }
  const policy = impactPolicy({ changes: policyChanges, selectedCount: selectedFiles.length, discoveryError });
  const testFiles = run('git', ['ls-files', '--cached', '--others', '--exclude-standard']).trim().split('\n').filter(file => /\.test\.(ts|tsx)$/.test(file) && /^(packages\/|__tests__\/)/.test(file));
  console.log(JSON.stringify({ ...compareSelection({ root, changedPaths, selectedFiles, testFiles, read: file => readFileSync(file, 'utf8') }), policy, discoveryError }, null, 2));
}
