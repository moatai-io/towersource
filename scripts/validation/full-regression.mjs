import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function runRegression({ root, revision, spawn = spawnSync, save = saveReceipt, now = Date.now, env = process.env }) {
  if (!/^[a-f0-9]{40}$/.test(revision || '')) throw Error('Exact 40-character commit SHA required');
  const runId = randomUUID();
  const directory = path.join(root, '.git', 'tower-full-regression', runId);
  const started = now();
  const receipt = { version: 1, runId, sourceRev: revision, status: 'running', startedAt: new Date(started).toISOString(), kind: 'full-regression', scheduled: false };
  save(directory, receipt);
  // Explicit canonical command ignores inherited custom/force settings and
  // reuses only compatible full evidence. The existing verifier owns snapshots.
  let result;
  try {
    result = spawn(path.join(root, 'scripts/git/pre-push-verified-state'), [revision], {
      cwd: root, stdio: 'inherit', shell: false,
      env: { ...env, TOWER_PREPUSH_ROOT: root, TOWER_PREPUSH_COMMAND: 'npm run preflight', TOWER_PREPUSH_FORCE_FULL: '0' },
    });
  } catch { result = { error: true }; }
  const code = result?.error || result?.signal || !Number.isInteger(result?.status) ? 1 : result.status;
  const completed = { ...receipt, status: code === 0 ? 'passed' : 'failed', exitCode: code, durationMs: now() - started };
  save(directory, completed);
  return { receipt: completed, directory, exitCode: code };
}
function saveReceipt(directory, receipt) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `receipt.${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path.join(directory, 'receipt.json'));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.length !== 3) throw Error('usage: node scripts/validation/full-regression.mjs <full-sha>');
  const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (root.status !== 0) throw Error('Registered Git checkout required');
  const result = runRegression({ root: root.stdout.trim(), revision: process.argv[2] });
  console.log(JSON.stringify({ ...result.receipt, receiptPath: path.join(result.directory, 'receipt.json') }));
  process.exitCode = result.exitCode;
}
