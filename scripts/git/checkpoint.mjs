#!/usr/bin/env node
/**
 * checkpoint.mjs — save a verified shared development tree as one Git commit.
 *
 * The command intentionally commits the repository's complete reviewed dirty
 * state, not files attributed to one Tower session. Safety comes from blocked
 * path checks and a fingerprint that must stay unchanged through validation.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const BLOCKED_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.p12|.*\.pfx)$/i,
  /(^|\/)(?:node_modules|dist|coverage|\.worktrees|\.git|\.npm)(\/|$)/,
  /^(?:data|logs?|cache|\.cache)(\/|$)/i,
  /\.(?:dump|sql\.gz|log)$/i,
];
const SECRET_FILE_PATTERN = /(^|\/)(?:secrets?|tokens?|credentials?|private[-_]?keys?)(?:\.(?:json|ya?ml|txt|env))?$/i;
const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    text: true,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function runOk(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout || '';
}

function die(message, code = 1) {
  console.error(`❌ ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    json: false,
    yes: false,
    message: '',
    repo: process.cwd(),
    expectedFingerprint: '',
    sessionId: process.env.TOWER_SESSION_ID || '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run' || arg === '-n') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--message' || arg === '-m') options.message = argv[++index] || '';
    else if (arg.startsWith('--message=')) options.message = arg.slice('--message='.length);
    else if (arg === '--repo') options.repo = argv[++index] || '';
    else if (arg.startsWith('--repo=')) options.repo = arg.slice('--repo='.length);
    else if (arg === '--expected-fingerprint') options.expectedFingerprint = argv[++index] || '';
    else if (arg.startsWith('--expected-fingerprint=')) options.expectedFingerprint = arg.slice('--expected-fingerprint='.length);
    else if (arg === '--session-id') options.sessionId = argv[++index] || '';
    else if (arg.startsWith('--session-id=')) options.sessionId = arg.slice('--session-id='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  node scripts/git/checkpoint.mjs --dry-run [--json]
  node scripts/git/checkpoint.mjs --message "chore(integration): ..." \\
    --expected-fingerprint <sha256> --yes

A real checkpoint requires the exact fingerprint produced before validation.
If any tracked, staged, or untracked content changes, the commit is refused.`);
      process.exit(0);
    } else die(`Unknown argument: ${arg}`);
  }
  return options;
}

function gitRoot(path) {
  return runOk('git', ['-C', resolve(path), 'rev-parse', '--show-toplevel']).trim();
}

function parseStatus(output) {
  return output.split('\n').filter(Boolean).map((line) => {
    const status = line.slice(0, 2);
    let path = line.slice(3).trim();
    if (path.includes(' -> ')) path = path.split(' -> ', 2)[1];
    return { status, path };
  });
}

function blockedReason(repo, entry) {
  const normalized = entry.path.replaceAll('\\', '/');
  const isPublicEnvTemplate = /(^|\/)\.env\.(?:example|sample|template)$/i.test(normalized);
  if (!isPublicEnvTemplate && BLOCKED_PATTERNS.some((pattern) => pattern.test(normalized))) return 'blocked path pattern';
  if (entry.status === '??' && SECRET_FILE_PATTERN.test(normalized)) return 'untracked secret-like filename';
  if (entry.status === '??') {
    const absolute = resolve(repo, entry.path);
    if (existsSync(absolute) && statSync(absolute).isFile() && statSync(absolute).size > MAX_UNTRACKED_BYTES) {
      return `untracked file exceeds ${MAX_UNTRACKED_BYTES} bytes`;
    }
  }
  return '';
}

function fingerprint(repo, entries) {
  const hash = createHash('sha256');
  hash.update(runOk('git', ['rev-parse', 'HEAD'], { cwd: repo }));
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const absolute = resolve(repo, entry.path);
    hash.update(`\0${entry.path}\0`);
    if (!existsSync(absolute)) {
      hash.update('<deleted>');
      continue;
    }
    const stats = statSync(absolute);
    hash.update(stats.isDirectory() ? '<directory>' : `<mode:${stats.mode & 0o111 ? 'executable' : 'file'}>`);
    if (stats.isFile()) hash.update(readFileSync(absolute));
  }
  return hash.digest('hex');
}

function snapshot(repo) {
  const statusOutput = runOk('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repo });
  const entries = parseStatus(statusOutput);
  const blocked = entries.map((entry) => ({ ...entry, reason: blockedReason(repo, entry) })).filter((entry) => entry.reason);
  return {
    repo,
    branch: runOk('git', ['branch', '--show-current'], { cwd: repo }).trim(),
    head: runOk('git', ['rev-parse', 'HEAD'], { cwd: repo }).trim(),
    entries,
    blocked,
    fingerprint: fingerprint(repo, entries),
  };
}

function printSnapshot(state) {
  console.log(`repo=${state.repo}`);
  console.log(`branch=${state.branch || '(detached)'}`);
  console.log(`head=${state.head}`);
  console.log(`fingerprint=${state.fingerprint}`);
  console.log(`dirty_files=${state.entries.length}`);
  for (const entry of state.entries) console.log(`  ${entry.status} ${entry.path}`);
  if (state.blocked.length) {
    console.log('blocked:');
    for (const entry of state.blocked) console.log(`  ${entry.path} — ${entry.reason}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const repo = gitRoot(options.repo);
  const state = snapshot(repo);
  if (options.json) console.log(JSON.stringify(state, null, 2));
  else printSnapshot(state);

  if (options.dryRun) {
    if (state.blocked.length) process.exitCode = 3;
    return;
  }
  if (!options.yes) die('Real checkpoint requires --yes after the user reviews the complete file list.');
  if (!options.message.trim()) die('Real checkpoint requires --message.');
  if (!options.expectedFingerprint) die('Real checkpoint requires --expected-fingerprint from the pre-validation dry-run.');
  if (!options.sessionId) die('TOWER_SESSION_ID is empty; checkpoint audit trailer cannot be written.');
  if (!state.entries.length) die('Working tree is clean; nothing to checkpoint.', 2);
  if (state.blocked.length) die(`Blocked files must be removed or intentionally handled first: ${state.blocked.map((item) => item.path).join(', ')}`);
  if (state.fingerprint !== options.expectedFingerprint) {
    die(`Working tree changed during validation. Expected ${options.expectedFingerprint}, found ${state.fingerprint}. Run dry-run and validation again.`);
  }

  runOk('git', ['diff', '--check'], { cwd: repo });
  runOk('git', ['add', '-A', '--'], { cwd: repo });
  const afterStage = snapshot(repo);
  if (afterStage.fingerprint !== options.expectedFingerprint) {
    die('Working tree changed while staging; checkpoint aborted. Review the index and run validation again.');
  }
  const message = `${options.message.trim()}\n\nTower-Session: ${options.sessionId}`;
  runOk('git', ['commit', '-m', message], { cwd: repo });
  console.log(`✅ Checkpoint committed: ${runOk('git', ['rev-parse', 'HEAD'], { cwd: repo }).trim()}`);
}

try {
  main();
} catch (error) {
  die(error?.message || String(error));
}
