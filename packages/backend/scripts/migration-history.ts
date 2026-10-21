import { shouldDeferMigrationForVm } from '../db/pg.js';

export interface MigrationHistoryRow {
  version: string;
  name?: string | null;
}

/**
 * Match db/pg.ts exactly: both version and extension-stripped name are keys;
 * numeric prefixes remain valid legacy keys, including shared-prefix files.
 * Do not narrow this compatibility rule here without changing the runner.
 * _migrations stores no content checksum, so this is identity, not SQL integrity,
 * verification. Unmatched rows are diagnostic only (old files may be retired).
 */
export function compareMigrationHistory(
  candidates: readonly string[],
  history: readonly MigrationHistoryRow[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const files = candidates.filter((file) => file.endsWith('.sql')).sort();
  const appliedKeys = new Set<string>();
  for (const row of history) {
    if (row.version) appliedKeys.add(row.version);
    if (row.name) appliedKeys.add(row.name.replace(/\.sql$/, ''));
  }
  const keys = (file: string) => [file.replace(/\.sql$/, ''), file.split('_')[0]];
  const pending: string[] = [];
  const deferred: string[] = [];
  const legacyPrefixMatches: string[] = [];
  for (const file of files) {
    const [key, legacy] = keys(file);
    if (appliedKeys.has(key) || appliedKeys.has(legacy)) {
      if (!appliedKeys.has(key) && appliedKeys.has(legacy)) legacyPrefixMatches.push(file);
    } else if (shouldDeferMigrationForVm(file, env)) {
      deferred.push(file);
    } else {
      pending.push(file);
    }
  }
  const candidateKeys = new Set(files.flatMap(keys));
  const unmatchedApplied = history.filter((row) => (
    !candidateKeys.has(row.version) &&
    !(row.name && candidateKeys.has(row.name.replace(/\.sql$/, '')))
  ));
  return {
    pending,
    pendingCount: pending.length,
    deferred,
    deferredCount: deferred.length,
    legacyPrefixMatches,
    unmatchedApplied,
    contentVerification: 'unavailable-no-stored-checksum' as const,
  };
}
