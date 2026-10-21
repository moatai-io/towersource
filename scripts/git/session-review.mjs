import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const digest = value => createHash('sha256').update(value).digest('hex');
const git = (repo, args) => execFileSync('git', args, { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
export function sessionReviewHash(summary) {
  const repos = summary.repos.filter(r => r.candidates.length).map(r => ({
    repo: r.repo,
    head: git(r.repo, ['rev-parse', 'HEAD']).toString().trim(),
    files: r.candidates.map(f => {
      let content;
      try {
        const stat = lstatSync(resolve(r.repo, f.rel));
        if (!stat.isFile()) throw Error('Review requires regular files');
        content = { mode: stat.mode, hash: digest(readFileSync(resolve(r.repo, f.rel))) };
      } catch (e) { if (e.code !== 'ENOENT') throw e; content = { deleted: true }; }
      return { path: f.rel, content, diff: digest(git(r.repo, ['diff', '--binary', 'HEAD', '--', f.rel])) };
    }).sort((a,b) => a.path.localeCompare(b.path)),
    conflicts: (summary.bashObservations?.find(o => o.repo === r.repo)?.conflicts || []).filter(p => r.candidates.some(f => f.rel === p)).sort(),
  })).sort((a,b) => a.repo.localeCompare(b.repo));
  return digest(JSON.stringify({ sessionId: summary.sessionId, repos }));
}
export function assertSessionReview(summary, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected || '') || sessionReviewHash(summary) !== expected) throw Error('Reviewed state changed; run dry-run and review again');
}
