/**
 * Read-only audit for Pi Session ↔ immutable Harness snapshot invariants.
 *
 * Usage:
 *   npx tsx packages/backend/scripts/audit-pi-session-harness-invariants.ts
 *   npx tsx packages/backend/scripts/audit-pi-session-harness-invariants.ts --json
 */
import { createHash } from 'node:crypto';
import { query } from '../db/pg-repo.js';

interface AuditRow {
  session_id: string;
  name: string;
  project_id: string | null;
  model_used: string | null;
  updated_at: string;
  harness_id: string | null;
  harness_version: number | null;
  runtime_profile_id: string | null;
  runtime_profile_version: number | null;
  snapshot_engine: string | null;
  snapshot: unknown;
  snapshot_hash: string | null;
}

interface AuditFinding {
  sessionId: string;
  name: string;
  projectId: string | null;
  updatedAt: string;
  problems: string[];
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashSnapshot(snapshot: unknown): string {
  return createHash('sha256').update(stable(snapshot)).digest('hex');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Audit active resumable Pi Sessions without changing data. */
export async function auditPiSessionHarnessInvariants(): Promise<AuditFinding[]> {
  const rows = await query<AuditRow>(
    `SELECT s.id AS session_id, s.name, s.project_id, s.model_used, s.updated_at::text,
            snap.harness_id, snap.harness_version, snap.runtime_profile_id,
            snap.runtime_profile_version, snap.engine AS snapshot_engine,
            snap.snapshot, snap.snapshot_hash
       FROM sessions s
       LEFT JOIN session_runtime_snapshots snap ON snap.session_id = s.id
      WHERE s.engine = 'pi'
        AND s.pi_session_file IS NOT NULL
        AND COALESCE(s.archived, 0) = 0
      ORDER BY s.updated_at DESC`,
  );

  return rows.flatMap((row) => {
    const problems: string[] = [];
    const snapshot = asRecord(row.snapshot);
    if (!snapshot) {
      problems.push('missing_or_invalid_snapshot');
    } else {
      if (row.harness_id !== snapshot.id) problems.push('harness_id_mismatch');
      if (Number(row.harness_version) !== Number(snapshot.version)) problems.push('harness_version_mismatch');
      if (row.runtime_profile_id !== snapshot.runtimeProfileId) problems.push('runtime_profile_id_mismatch');
      if (Number(row.runtime_profile_version) !== Number(snapshot.runtimeProfileVersion)) problems.push('runtime_profile_version_mismatch');
      if (row.snapshot_engine !== snapshot.engine || snapshot.engine !== 'pi') problems.push('engine_mismatch');
      if (row.snapshot_hash !== hashSnapshot(snapshot)) problems.push('snapshot_hash_mismatch');
      const allowedModels = Array.isArray(snapshot.allowedModels) ? snapshot.allowedModels : null;
      if (row.model_used && allowedModels && !allowedModels.includes(row.model_used)) {
        problems.push('model_policy_mismatch');
      }
    }
    if (problems.length === 0) return [];
    return [{
      sessionId: row.session_id,
      name: row.name,
      projectId: row.project_id,
      updatedAt: row.updated_at,
      problems,
    }];
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const json = process.argv.includes('--json');
  const findings = await auditPiSessionHarnessInvariants();
  if (json) {
    console.log(JSON.stringify({ ok: findings.length === 0, count: findings.length, findings }, null, 2));
  } else if (findings.length === 0) {
    console.log('OK: active resumable Pi Sessions all have valid pinned Harness snapshots.');
  } else {
    console.error(`FAIL: ${findings.length} active resumable Pi Session(s) violate the Harness snapshot invariant.`);
    for (const finding of findings) {
      console.error(`- ${finding.sessionId} ${JSON.stringify(finding.name)}: ${finding.problems.join(', ')}`);
    }
  }
  process.exitCode = findings.length === 0 ? 0 : 2;
}
