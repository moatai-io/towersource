import { sessionAudienceSql } from '../pm/session-audience.js';
import { canAccessSession } from '../pm/project-access.js';
/**
 * session-backlinks.ts — Level 1 (공통 파일 기반) session backlinks.
 *
 * Returns "other sessions that edited the same files" for a given session.
 * Uses IDF scoring on shared file_edit events to surface meaningfully-related
 * sessions while de-weighting hot files like `api.ts` touched by everyone.
 *
 * Data source (since 2026-05-20 PG unification):
 *   - session_file_edits (PostgreSQL) — written by both engines:
 *       · Claude  → PostToolUse hook in claude-sdk.ts queryOptions
 *                   (makePostToolUseFileEditLog factory in workspace/file-edit-log.ts)
 *       · Pi      → pi-engine.ts tool_execution_end
 *     Both record keyed by Tower sessions.id directly. No more memory.db
 *     UNION, no more claude_session_id → sessions.id mapping round-trip.
 *   - sessions (PostgreSQL) — final metadata + access filter.
 *
 * Access control (2026-05-20, cross-user):
 *   Candidate sessions are filtered to those the *caller* is allowed to see —
 *   own + project-member + internal-share + admin/operator. Private sessions
 *   of other users stay hidden. Result rows carry the owner's userId /
 *   displayName so the UI can show "by <name>" for cross-user matches.
 *
 * See: workspace/decisions/2026-04-21-session-backlinks-level1.md (origin)
 *      workspace/decisions/2026-05-20-session-backlinks-cross-user.md (ACL relax)
 *      workspace/decisions/2026-05-20-session-file-edits-pg-unification.md (PG single source)
 */
import { query, queryOne } from '../../db/pg-repo.js';
import type { RelatedSessionResult, RelatedSessionsResponse } from '@tower/shared';

// Project meta files: touched by almost every session, so nearly zero
// evidential value as "why these are related". Hidden from the sharedFiles
// UI (scoring still uses them). Matched by basename (case-insensitive).
const META_FILE_BASENAMES = new Set([
  'claude.md',
  'readme.md',
  'agents.md',
  'memory.md',
  'codify.md',
  '.env',
  '.env.example',
  '.env.local',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'tsconfig.json',
  '.gitignore',
  'index.ts', // entrypoints: almost every feature touches them
  'index.tsx',
  'index.js',
]);

function isMetaFile(filePath: string): boolean {
  const slash = filePath.lastIndexOf('/');
  const base = (slash >= 0 ? filePath.slice(slash + 1) : filePath).toLowerCase();
  return META_FILE_BASENAMES.has(base);
}

function basename(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return (slash >= 0 ? filePath.slice(slash + 1) : filePath).toLowerCase();
}

/**
 * Compatibility no-op. Previously ensured a SQLite index on memory.db.
 * Kept as an exported function so callers that call it at boot don't break;
 * memory.db is no longer touched. Safe to remove once all call sites are gone.
 *
 * @deprecated since 2026-05-20 — PG unification removed memory.db dependency.
 */
export function ensureMemoryIndex(): void {
  // intentionally empty — memory.db no longer in use
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Find sessions related to the given session by shared edited files.
 *
 * Access control (2026-05-20):
 *   Candidates are filtered to sessions the *caller* is allowed to see —
 *   - their own sessions
 *   - sessions where caller is project member (project_id == one of theirs)
 *   - sessions explicitly shared internally with caller (internal_shares row)
 *   - all sessions, if caller is admin/operator
 *   Permission check on the *target* session happens at the API layer.
 *
 * @param towerSessionId   — Tower `sessions.id` (UUID). Used as the stable key
 *                           across engines.
 * @param _claudeSessionId — Unused since 2026-05-20 PG unification. Kept in
 *                           the signature for API back-compat; the API layer
 *                           still passes it.
 * @param userId           — caller's Tower user id.
 * @param role             — caller's role; admin/operator bypass per-candidate access check.
 * @param limit            — max results (1-50, default 10).
 */
export async function getRelatedSessionsByFiles(
  towerSessionId: string,
  _claudeSessionId: string | null | undefined,
  userId: number,
  role: string,
  limit = 10,
): Promise<RelatedSessionsResponse> {
  const started = Date.now();
  const n = Math.max(1, Math.min(50, Math.floor(limit) || 10));
  if (!(await canAccessSession(towerSessionId, userId, role)).allowed) {
    return { filesInSession: 0, candidatesConsidered: 0, queryMs: Date.now() - started, results: [] };
  }

  // 1. Source files — single PG query, keyed directly by Tower sessions.id.
  const fileRows = await query<{ file_path: string }>(
    `SELECT DISTINCT file_path FROM session_file_edits WHERE session_id = $1`,
    [towerSessionId],
  );
  const sourceFiles = new Set<string>(fileRows.map((r) => r.file_path));

  if (sourceFiles.size === 0) {
    return {
      filesInSession: 0,
      candidatesConsidered: 0,
      queryMs: Date.now() - started,
      results: [],
    };
  }

  const files = [...sourceFiles];

  // 2. Candidate sessions that also touched those files. UNIQUE on
  //    (session_id, file_path) means one row per (session, file) pair.
  const sfeRows = await query<{ file_path: string; session_id: string }>(
    `SELECT sfe.file_path, sfe.session_id FROM session_file_edits sfe
       JOIN sessions s ON s.id = sfe.session_id
       WHERE sfe.file_path = ANY($1::text[]) AND sfe.session_id != $2
         AND ${sessionAudienceSql('s', '$3')}`,
    role === 'admin' ? [files, towerSessionId] : [files, towerSessionId, userId],
  );

  const sessionsPerFile = new Map<string, Set<string>>(); // file → Set<sessions.id>
  const sharedByCandidate = new Map<string, Set<string>>(); // sessions.id → Set<file>
  for (const r of sfeRows) {
    let s = sessionsPerFile.get(r.file_path);
    if (!s) { s = new Set(); sessionsPerFile.set(r.file_path, s); }
    s.add(r.session_id);
    let f = sharedByCandidate.get(r.session_id);
    if (!f) { f = new Set(); sharedByCandidate.set(r.session_id, f); }
    f.add(r.file_path);
  }

  // Include source in per-file counts so IDF reflects total edited_by cardinality.
  for (const file of files) {
    let s = sessionsPerFile.get(file);
    if (!s) { s = new Set(); sessionsPerFile.set(file, s); }
    s.add(towerSessionId);
  }

  // 3. IDF denominator — distinct sessions in session_file_edits.
  const totalRow = await queryOne<{ n: number }>(
    `SELECT COUNT(DISTINCT sfe.session_id)::int AS n FROM session_file_edits sfe
       JOIN sessions s ON s.id = sfe.session_id
       WHERE ${sessionAudienceSql('s', '$1')}`,
    role === 'admin' ? [] : [userId],
  );
  const totalSessions = Math.max(1, totalRow?.n ?? 0);

  // 4. Score candidates by IDF sum; drop those below the hot-file noise floor.
  //    Also compute a per-pair "display set" that hides hot files from the
  //    evidence UI — empirically sessions often share an api.ts/index.ts
  //    alongside rare files, and the sort-by-rarity alone wasn't enough to
  //    keep hot files out of the top-2 evidence slots.
  //
  //    HOT_FILE_RATIO: a file touched by > 5% of all sessions is considered
  //    a hot file and hidden from the evidence UI. Scoring (IDF) still uses
  //    every shared file — this only filters what the user sees as "why".
  //
  //    Fallback: if a candidate's entire shared set is hot, we show the
  //    least-hot file anyway so the UI never displays a session with zero
  //    evidence.
  type Candidate = { sessionId: string; score: number; shared: string[] };
  const threshold = Math.log(totalSessions / 30);
  const HOT_FILE_RATIO = 0.05;
  const hotCutoff = totalSessions * HOT_FILE_RATIO;
  const candidates: Candidate[] = [];
  for (const [candidateId, sharedFiles] of sharedByCandidate) {
    let score = 0;
    for (const file of sharedFiles) {
      const nTouching = sessionsPerFile.get(file)?.size ?? 1;
      score += Math.log(totalSessions / nTouching);
    }
    // A pair whose ENTIRE shared evidence is meta files (CLAUDE.md,
    // package.json, etc.) is not really "related" — those are touched by
    // almost every session. Drop it regardless of score.
    const hasNonMeta = [...sharedFiles].some((f) => !isMetaFile(f));
    if (!hasNonMeta) continue;

    if (score >= threshold) {
      // Rarity-sort shared files (ascending n_touching = most distinctive first)
      const sortedFiles = [...sharedFiles].sort((a, b) => {
        const na = sessionsPerFile.get(a)?.size ?? 1;
        const nb = sessionsPerFile.get(b)?.size ?? 1;
        return na - nb;
      });
      // Display-layer filter:
      //   (a) meta files (CLAUDE.md, package.json, index.ts, ...) — hidden,
      //       they're edited by nearly every session and add zero evidential value.
      //   (b) statistically hot files (n_touching > 5% of total sessions).
      // Dedupe by basename so "workspace/CLAUDE.md" and "tower/workspace/CLAUDE.md"
      // don't both appear — keep the rarer variant.
      const seenBasenames = new Set<string>();
      let displayFiles = sortedFiles.filter((f) => {
        if (isMetaFile(f)) return false;
        const n = sessionsPerFile.get(f)?.size ?? 1;
        if (n > hotCutoff) return false;
        const b = basename(f);
        if (seenBasenames.has(b)) return false;
        seenBasenames.add(b);
        return true;
      });
      // Fallback: filters may strip every shared file even though hasNonMeta
      // guaranteed at least one exists. Surface the least-hot non-meta file
      // so the UI never shows an evidence-less match.
      if (displayFiles.length === 0) {
        const leastHotNonMeta = sortedFiles.find((f) => !isMetaFile(f));
        if (leastHotNonMeta) displayFiles = [leastHotNonMeta];
      }
      candidates.push({ sessionId: candidateId, score, shared: displayFiles });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    return {
      filesInSession: files.length,
      candidatesConsidered: sharedByCandidate.size,
      queryMs: Date.now() - started,
      results: [],
    };
  }

  // 5. Metadata + access filter (cross-user, 2026-05-20).
  //    For each candidate session we need: id, name, owner (user_id +
  //    display_name + username), project_id, updated_at. Then we drop the
  //    ones the caller can't see per Tower's standard session ACL.
  const candidateIds = candidates.map((c) => c.sessionId);
  // 5b. Pull candidate metadata + owner info in a single JOIN.
  const pgRows = await query<{
    id: string;
    name: string;
    project_id: string | null;
    updated_at: Date | string;
    user_id: number | null;
    username: string | null;
    display_name: string | null;
  }>(
    `SELECT s.id, s.name, s.project_id, s.updated_at,
            s.user_id, u.username, u.display_name
       FROM sessions s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.id = ANY($1::text[])
         AND (s.archived IS NULL OR s.archived = 0)
         AND ${sessionAudienceSql('s', '$2')}`,
    role === 'admin' ? [candidateIds] : [candidateIds, userId],
  );
  const byId = new Map<string, (typeof pgRows)[number]>();
  for (const row of pgRows) byId.set(row.id, row);

  // 6. Build results preserving score order; apply per-candidate access filter
  //    silently. Score-desc iteration over ALL candidates (not a pre-slice)
  //    ensures accessible sessions further down the list aren't starved by
  //    inaccessible top-scoring ones.
  const results: RelatedSessionResult[] = [];
  for (const cand of candidates) {
    if (results.length >= n) break;
    const meta = byId.get(cand.sessionId);
    if (!meta) continue;

    results.push({
      sessionId: meta.id,
      name: meta.name,
      score: Number(cand.score.toFixed(3)),
      sharedFiles: cand.shared.slice(0, 2).map((p) => ({ path: p })),
      projectId: meta.project_id,
      updatedAt:
        meta.updated_at instanceof Date
          ? meta.updated_at.toISOString()
          : String(meta.updated_at),
      userId: meta.user_id,
      username: meta.username,
      displayName: meta.display_name,
      isMine: meta.user_id === userId,
    });
  }

  return {
    filesInSession: files.length,
    candidatesConsidered: sharedByCandidate.size,
    queryMs: Date.now() - started,
    results,
  };
}
