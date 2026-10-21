#!/usr/bin/env node
/**
 * commit-session.mjs — commit only files touched by the current Tower session.
 *
 * Owns: fixed, testable git safety logic for /commit-session.
 * AI still proposes the commit message; this script owns file selection,
 * specific git add, commit execution, and Tower-Session trailer insertion.
 */
import { existsSync, statSync, appendFileSync } from 'node:fs';
import { sessionReviewHash, assertSessionReview } from './session-review.mjs';
import { readBashObservations } from './bash-observations.mjs';
import { selectSessionCandidates } from './session-selection.mjs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOME = homedir();
const BLOCKED_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.p12|.*\.pfx)$/i,
  /(^|\/)(?:node_modules|dist|coverage|\.worktrees|\.git|\.npm)(\/|$)/,
  /^(?:data|logs?|cache|\.cache)(\/|$)/i,
  /\.(?:dump|sql\.gz|log)$/i,
];
const SECRET_FILE_PATTERN = /(^|\/)(?:secrets?|tokens?|credentials?|private[-_]?keys?)(?:\.(?:json|ya?ml|txt|env))?$/i;
const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024;
const DEFAULT_PG = {
  host: process.env.PGHOST || '127.0.0.1',
  port: process.env.PGPORT || '5433',
  user: process.env.PGUSER || 'tower',
  database: process.env.PGDATABASE || 'tower_chat',
  password: process.env.PGPASSWORD || 'tower_dev_2026',
};

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    json: false,
    yes: false,
    allRepos: false,
    verbose: false,
    includeUntracked: true,
    fallbackProvenance: true,
    reviewedHash: '',
    selectedPaths: [],
    message: '',
    repo: '',
    sessionId: process.env.TOWER_SESSION_ID || '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '-n') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--yes' || arg === '-y') opts.yes = true;
    else if (arg === '--all-repos') opts.allRepos = true;
    else if (arg === '--verbose' || arg === '-v') opts.verbose = true;
    else if (arg === '--path') opts.selectedPaths.push(argv[++i] || '');
    else if (arg === '--reviewed-hash') opts.reviewedHash = argv[++i] || '';
    else if (arg === '--no-untracked') opts.includeUntracked = false;
    else if (arg === '--no-provenance-fallback') opts.fallbackProvenance = false;
    else if (arg === '--message' || arg === '-m') opts.message = argv[++i] || '';
    else if (arg.startsWith('--message=')) opts.message = arg.slice('--message='.length);
    else if (arg === '--repo') opts.repo = argv[++i] || '';
    else if (arg.startsWith('--repo=')) opts.repo = arg.slice('--repo='.length);
    else if (arg === '--session-id') opts.sessionId = argv[++i] || '';
    else if (arg.startsWith('--session-id=')) opts.sessionId = arg.slice('--session-id='.length);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      die(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Usage:
  node scripts/git/commit-session.mjs --dry-run [--json]
  node scripts/git/commit-session.mjs --message "feat: ..." --yes

Options:
  --dry-run, -n                 Show touched/dirty files without staging or committing.
  --message, -m <msg>           Commit message subject/body. Tower-Session trailer is appended.
  --yes, -y                     Required for a real commit.
  --repo <path>                 Limit execution to one git repository.
  --all-repos                   Include every git repo touched by this session.
                                Default is the current working directory's repo.
  --session-id <uuid>           Override TOWER_SESSION_ID.
  --json                        Emit machine-readable JSON summary.
  --path <relative-path>       Repeat to narrow recorded candidates; requires reviewed hash for commit.
  --reviewed-hash <sha256>      Exact dry-run review hash approved after checking temporal overlaps; never adds files.
  --verbose, -v                 Print every untouched dirty file.
  --no-untracked                Exclude untracked files from the candidate set.
  --no-provenance-fallback      Do not read legacy ~/workspace/.audit/provenance.jsonl.
`);
}

function die(message, code = 1) {
  console.error(`❌ ${message}`);
  process.exit(code);
}

function run(command, args, options = {}) {
  const res = spawnSync(command, args, {
    text: true,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    ...options,
    env: options.env || process.env,
  });
  if (res.error) throw res.error;
  return res;
}

function runOk(command, args, options = {}) {
  const res = run(command, args, options);
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return res.stdout || '';
}

function normalizePath(filePath, cwd) {
  if (!filePath) return null;
  let p = String(filePath).trim().replace(/^[']|[']$/g, '').replace(/^["]|["]$/g, '');
  if (!p) return null;
  if (p.startsWith('~/')) p = HOME + p.slice(1);
  if (isAbsolute(p)) return normalize(p);
  const base = cwd && cwd.trim() ? cwd.trim() : process.cwd();
  return normalize(resolve(base, p));
}

function psqlRows(query) {
  const env = { ...process.env, PGPASSWORD: DEFAULT_PG.password };
  const args = [
    '-h', DEFAULT_PG.host,
    '-p', DEFAULT_PG.port,
    '-U', DEFAULT_PG.user,
    '-d', DEFAULT_PG.database,
    '-At',
    '-F', '\t',
    '-c', query,
  ];
  const res = run('psql', args, { env });
  if (res.status !== 0) return { ok: false, error: (res.stderr || res.stdout || '').trim(), rows: [] };
  return { ok: true, error: '', rows: (res.stdout || '').split('\n').filter(Boolean) };
}

function getSessionPathsFromPg(sessionId) {
  const escaped = sessionId.replaceAll("'", "''");
  const query = `
SELECT sfe.file_path, COALESCE(s.cwd, '') AS cwd
FROM session_file_edits sfe
LEFT JOIN sessions s ON s.id = sfe.session_id
WHERE sfe.session_id = '${escaped}'
ORDER BY sfe.created_at DESC
`;
  const result = psqlRows(query);
  if (!result.ok) return { ok: false, error: result.error, paths: [] };
  const paths = [];
  for (const row of result.rows) {
    const [filePath, cwd = ''] = row.split('\t');
    const abs = normalizePath(filePath, cwd);
    if (abs) paths.push(abs);
  }
  return { ok: true, error: '', paths: [...new Set(paths)].sort() };
}

function getSessionPathsFromProvenance(sessionId) {
  const provenance = join(HOME, 'workspace/.audit/provenance.jsonl');
  if (!existsSync(provenance)) return { ok: false, error: `${provenance} not found`, paths: [] };
  const jq = run('jq', [
    '-r',
    '--arg', 'tsi', sessionId,
    'select(.towerSessionId == $tsi) | (.path // empty)',
    provenance,
  ]);
  if (jq.status !== 0) return { ok: false, error: (jq.stderr || jq.stdout || '').trim(), paths: [] };
  const paths = [...new Set((jq.stdout || '').split('\n').map((p) => normalizePath(p, process.cwd())).filter(Boolean))].sort();
  return { ok: true, error: '', paths };
}

function existingStartForGit(path) {
  let p = path;
  try {
    if (existsSync(p) && statSync(p).isDirectory()) return p;
  } catch {}
  p = dirname(p);
  while (p && p !== dirname(p)) {
    if (existsSync(p)) return p;
    p = dirname(p);
  }
  return process.cwd();
}

function gitRootFor(path) {
  const start = existingStartForGit(path);
  const res = run('git', ['-C', start, 'rev-parse', '--show-toplevel'], { stderr: 'pipe' });
  if (res.status !== 0) return null;
  return normalize((res.stdout || '').trim());
}

function parseStatusPorcelain(output, repo) {
  const files = new Map();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    let rel = line.slice(3).trim();
    if (rel.includes(' -> ')) rel = rel.split(' -> ', 2)[1];
    const abs = normalize(join(repo, rel));
    files.set(abs, { rel: normalize(rel), status });
  }
  return files;
}

function repoStatus(repo) {
  const out = runOk('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repo });
  return parseStatusPorcelain(out, repo);
}

function blockedReason(candidate) {
  const normalized = candidate.rel.replaceAll('\\', '/');
  const isPublicEnvTemplate = /(^|\/)\.env\.(?:example|sample|template)$/i.test(normalized);
  if (!isPublicEnvTemplate && BLOCKED_PATTERNS.some((pattern) => pattern.test(normalized))) return 'blocked path pattern';
  if (candidate.status === '??' && SECRET_FILE_PATTERN.test(normalized)) return 'untracked secret-like filename';
  if (candidate.status === '??' && existsSync(candidate.abs) && statSync(candidate.abs).isFile() && statSync(candidate.abs).size > MAX_UNTRACKED_BYTES) {
    return `untracked file exceeds ${MAX_UNTRACKED_BYTES} bytes`;
  }
  return '';
}

function groupCandidates(paths, opts) {
  const byRepo = new Map();
  const skipped = [];
  for (const path of paths) {
    const repo = gitRootFor(path);
    if (!repo) {
      skipped.push({ path, reason: 'not in git repo' });
      continue;
    }
    if (opts.repo) {
      const wanted = normalize(resolve(opts.repo));
      if (repo !== wanted) continue;
    }
    if (!byRepo.has(repo)) byRepo.set(repo, { touched: new Set(), candidates: [], untouchedDirty: [], skipped: [] });
    byRepo.get(repo).touched.add(normalize(path));
  }

  for (const [repo, entry] of byRepo.entries()) {
    const status = repoStatus(repo);
    for (const [abs, info] of status.entries()) {
      const isTouched = entry.touched.has(abs);
      const isUntracked = info.status === '??';
      if (isTouched && (opts.includeUntracked || !isUntracked)) {
        const candidate = { abs, rel: info.rel, status: info.status };
        const reason = blockedReason(candidate);
        if (reason) entry.skipped.push({ path: abs, reason });
        else entry.candidates.push(candidate);
      } else if (!isTouched) {
        entry.untouchedDirty.push({ abs, rel: info.rel, status: info.status });
      } else if (isUntracked) {
        entry.skipped.push({ path: abs, reason: 'untracked excluded by --no-untracked' });
      }
    }
    entry.candidates.sort((a, b) => a.rel.localeCompare(b.rel));
    entry.untouchedDirty.sort((a, b) => a.rel.localeCompare(b.rel));
  }
  return { byRepo, skipped };
}

function buildSummary(opts, source, sourceError, paths, grouped) {
  const repos = [...grouped.byRepo.entries()].map(([repo, entry]) => ({
    repo,
    touchedCount: entry.touched.size,
    candidates: entry.candidates,
    untouchedDirty: entry.untouchedDirty,
    skipped: entry.skipped,
  }));
  return {
    sessionId: opts.sessionId,
    source,
    sourceError,
    dryRun: opts.dryRun,
    allRepos: opts.allRepos,
    targetRepo: opts.repo || null,
    touchedPathCount: paths.length,
    repos,
    skipped: grouped.skipped,
  };
}

function printSummary(summary, opts) {
  console.log(`TOWER_SESSION_ID=${summary.sessionId}`);
  console.log(`source=${summary.source}${summary.sourceError ? ` (${summary.sourceError})` : ''}`);
  console.log(`scope=${summary.allRepos ? 'all repos touched by this session' : summary.targetRepo}`);
  console.log(`touched_paths=${summary.touchedPathCount}`);
  for (const observation of summary.bashObservations || []) {
    console.log(`bash evidence (${observation.repo}): ${observation.status}; review-only=${observation.candidates.length}; overlap=${observation.conflicts.length}`);
    for (const file of observation.candidates) console.log(`  ${observation.conflicts.includes(file) ? 'overlap' : 'unconfirmed'} ${file}`);
  }
  for (const repo of summary.repos) {
    console.log(`\n[${repo.repo}]`);
    if (repo.candidates.length) {
      console.log('commit candidates:');
      for (const f of repo.candidates) console.log(`  ${f.status} ${f.rel}`);
    } else {
      console.log('commit candidates: none');
    }
    if (repo.untouchedDirty.length) {
      const shown = opts.verbose ? repo.untouchedDirty : repo.untouchedDirty.slice(0, 10);
      console.log(`left untouched (not this session): ${repo.untouchedDirty.length} file(s)`);
      for (const f of shown) console.log(`  ${f.status} ${f.rel}`);
      if (!opts.verbose && repo.untouchedDirty.length > shown.length) {
        console.log(`  ... ${repo.untouchedDirty.length - shown.length} more. Use --verbose to show all.`);
      }
    }
    if (repo.skipped.length) {
      console.log('skipped:');
      for (const f of repo.skipped) console.log(`  ${f.path} — ${f.reason}`);
    }
  }
  if (summary.skipped.length) {
    console.log('\n[not in git repo]');
    for (const s of summary.skipped) console.log(`  ${s.path} — ${s.reason}`);
  }
}

function stagedFiles(repo) {
  return runOk('git', ['diff', '--cached', '--name-only'], { cwd: repo })
    .split('\n')
    .filter(Boolean)
    .map((r) => normalize(r));
}

function commitRepo(repo, files, message, sessionId) {
  const rels = files.map((f) => f.rel);
  const allowed = new Set(rels.map((r) => normalize(r)));
  const preStagedUnexpected = stagedFiles(repo).filter((r) => !allowed.has(r));
  if (preStagedUnexpected.length) {
    throw new Error(`Refusing commit: pre-existing staged files outside this session set in ${repo}: ${preStagedUnexpected.join(', ')}`);
  }

  runOk('git', ['add', '--', ...rels], { cwd: repo });
  const unexpected = stagedFiles(repo).filter((r) => !allowed.has(r));
  if (unexpected.length) {
    throw new Error(`Refusing commit: staged files outside this session set in ${repo}: ${unexpected.join(', ')}`);
  }
  const finalMessage = `${message.trim()}\n\nTower-Session: ${sessionId}`;
  runOk('git', ['commit', '-m', finalMessage], { cwd: repo });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.sessionId) die('TOWER_SESSION_ID is empty. Pass --session-id or run inside a Tower session.');

  let source = 'pg';
  let sourceError = '';
  const pg = getSessionPathsFromPg(opts.sessionId);
  let paths = pg.paths;
  if (!pg.ok) sourceError = pg.error;
  if ((!pg.ok || paths.length === 0) && opts.fallbackProvenance) {
    const fallback = getSessionPathsFromProvenance(opts.sessionId);
    if (fallback.ok && fallback.paths.length) {
      source = 'provenance';
      sourceError = pg.ok ? 'PG returned 0 rows' : `PG failed: ${pg.error}`;
      paths = fallback.paths;
    }
  }

  if (!opts.allRepos && !opts.repo) {
    const currentRepo = gitRootFor(process.cwd());
    if (!currentRepo) die('Current working directory is not inside a git repository. Pass --repo or --all-repos.');
    opts.repo = currentRepo;
  }

  const grouped = groupCandidates(paths, opts);
  const summary = selectSessionCandidates(buildSummary(opts, source, sourceError, paths, grouped), opts.selectedPaths);
  // Evidence is deliberately separate from confirmed candidates, even if PG returned zero rows.
  summary.bashObservations = [...new Set([opts.repo, ...summary.repos.map(r => r.repo)].filter(Boolean))].map(repo => {
    const gitDir = runOk('git', ['rev-parse', '--git-common-dir'], { cwd: repo }).trim();
    return { repo, ...readBashObservations(resolve(repo, gitDir, 'tower-bash-observations.jsonl'), opts.sessionId) };
  });

  summary.reviewHash = sessionReviewHash(summary);
  if (opts.json) console.log(JSON.stringify(summary, null, 2));
  else printSummary(summary, opts);

  // A temporal overlap cannot establish who owns the current diff. Fail closed.
  const overlapBlocked = summary.repos.flatMap(repo => {
    const observation = summary.bashObservations.find(o => o.repo === repo.repo);
    return repo.candidates.filter(f => observation?.conflicts.includes(f.rel)).map(f => f.rel);
  });
  const totalCandidates = summary.repos.reduce((n, repo) => n + repo.candidates.length, 0);
  if (opts.dryRun) return;
  if (opts.selectedPaths.length && !opts.reviewedHash) die('Selected paths require --reviewed-hash from the approved dry-run');
  if (overlapBlocked.length && !opts.reviewedHash) die(`Cross-session bash evidence requires review: ${overlapBlocked.join(', ')}`);
  if (opts.reviewedHash) assertSessionReview(summary, opts.reviewedHash);
  if (!opts.message.trim()) die('Real commit requires --message. Let AI propose the message, then pass it here.');
  if (!opts.yes) die('Real commit requires --yes after the user has confirmed paths + message.');
  if (totalCandidates === 0) die('No dirty files touched by this session; nothing to commit.', 2);

  for (const repo of summary.repos) {
    if (!repo.candidates.length) continue;
    console.log(`\nCommitting ${repo.candidates.length} file(s) in ${repo.repo}`);
    if (opts.reviewedHash) {
      assertSessionReview(summary, opts.reviewedHash);
      const gitDir = runOk('git', ['rev-parse', '--git-common-dir'], { cwd: repo.repo }).trim();
      appendFileSync(resolve(repo.repo, gitDir, 'tower-session-reviews.jsonl'), JSON.stringify({ sessionId: opts.sessionId, hash: opts.reviewedHash, paths: repo.candidates.map(f => f.rel), conflicts: overlapBlocked, message: opts.message, reviewedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
    }
    commitRepo(repo.repo, repo.candidates, opts.message, opts.sessionId);
  }
}

try {
  main();
} catch (err) {
  die(err?.message || String(err));
}
