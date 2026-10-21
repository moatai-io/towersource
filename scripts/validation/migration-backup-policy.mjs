import { createHash } from 'node:crypto';

// Explicit, content-bound reviews only. Unclassified changes always need backup.
export function migrationBackupPolicy(migrations, reviews = {}) {
  const decisions = migrations.map(({ path, sql }) => {
    const digest = createHash('sha256').update(sql).digest('hex');
    const review = reviews[path];
    const approved = review?.sha256 === digest && review?.risk === 'non-destructive'
      && typeof review.reason === 'string' && review.reason.trim()
      && typeof review.recovery === 'string' && review.recovery.trim()
      && typeof review.verify === 'string' && review.verify.trim();
    return { path, sha256: digest, risk: approved ? review.risk : 'unclassified', reason: approved ? review.reason : 'No matching complete review', recovery: approved ? review.recovery : null, verify: approved ? review.verify : null };
  });
  return { backup: decisions.length && decisions.every(d => d.risk === 'non-destructive') ? 'schema-record' : 'full', decisions };
}
