#!/usr/bin/env tsx
/**
 * backfill-memory-db-to-pg.ts — one-shot import: ~/.claude/memory.db file_edit
 * rows → PostgreSQL session_file_edits.
 *
 * Run once during the 2026-05-20 PG unification (memory.db dependency removal).
 * After this script + the dual-write hook in claude-sdk.ts, session_file_edits
 * becomes the single source of truth for session backlinks.
 *
 * Run:
 *   cd ~/tower && npx tsx scripts/backfill-memory-db-to-pg.ts          # dry-run
 *   cd ~/tower && npx tsx scripts/backfill-memory-db-to-pg.ts --apply  # actually insert
 *
 * Idempotent — INSERT ... ON CONFLICT DO NOTHING on the new UNIQUE
 * (session_id, file_path) index (migration 063). Safe to re-run.
 *
 * Mapping: memory.db.session_id is the Claude SDK UUID. We translate to Tower
 * sessions.id via the sessions.claude_session_id column. Orphan memory rows
 * (no matching Tower session) are skipped silently.
 *
 * Path predicate: only ~/workspace/* and ~/tower/* — matches the new hook's
 * isTracked() so the backfill set stays consistent with what dual-write
 * captures going forward.
 *
 * See: workspace/decisions/2026-05-20-session-file-edits-pg-unification.md
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { execute, query } from '../packages/backend/db/pg-repo.js';

const APPLY = process.argv.includes('--apply');
const HOME = os.homedir();
const WORKSPACE = path.join(HOME, 'workspace');
const TOWER_REPO = path.join(HOME, 'tower');

function isTracked(p: string): boolean {
  return p.startsWith(WORKSPACE + path.sep) || p.startsWith(TOWER_REPO + path.sep);
}

interface MemRow {
  session_id: string;
  file_path: string;
  tool: string | null;
}

async function main() {
  const _require = createRequire(import.meta.url);
  let nodeSqlite: any;
  try {
    nodeSqlite = _require('node:sqlite');
  } catch {
    console.error('node:sqlite unavailable (Node < 22.5). Cannot read memory.db. Aborting.');
    process.exit(1);
  }

  const memPath = path.join(HOME, '.claude', 'memory.db');
  console.log(`[backfill] reading ${memPath} (read-only)`);
  const db = new nodeSqlite.DatabaseSync(memPath, { readOnly: true });

  // memory.db schema: memories(session_id, type, file_path, ... tool ...).
  // Some legacy rows lack tool_name; default to 'unknown' for those.
  // Single SELECT — memory.db is local SQLite, full scan is fast (~150ms).
  const memRows = db
    .prepare(
      `SELECT DISTINCT session_id, file_path, COALESCE(tool_name, '') AS tool
         FROM memories
         WHERE type = 'file_edit'
           AND session_id IS NOT NULL
           AND file_path IS NOT NULL`,
    )
    .all() as MemRow[];

  console.log(`[backfill] memory.db rows: ${memRows.length}`);

  // Path filter — keep only tracked roots
  const tracked = memRows.filter((r) => isTracked(r.file_path));
  console.log(`[backfill] tracked-path rows: ${tracked.length} (dropped ${memRows.length - tracked.length} out-of-tree)`);

  // Build claude_session_id → tower sessions.id mapping in one PG round-trip
  const claudeSids = [...new Set(tracked.map((r) => r.session_id))];
  console.log(`[backfill] distinct claude_session_ids: ${claudeSids.length}`);
  const mappingRows = await query<{ id: string; claude_session_id: string }>(
    `SELECT id, claude_session_id FROM sessions
       WHERE claude_session_id = ANY($1::text[])`,
    [claudeSids],
  );
  const claudeToTower = new Map<string, string>();
  for (const r of mappingRows) claudeToTower.set(r.claude_session_id, r.id);
  console.log(`[backfill] mapped to Tower sessions: ${mappingRows.length} / ${claudeSids.length}`);
  console.log(`[backfill] orphan (no Tower session row): ${claudeSids.length - mappingRows.length} — silently skipped`);

  // Translate + dedupe (memory.db DISTINCT already collapses within one
  // claude_sid, but two different claude_sids can map to the same Tower id
  // if the session resumed — collapse here too).
  type Insertion = { towerSessionId: string; filePath: string; tool: string };
  const insertions: Insertion[] = [];
  const seen = new Set<string>(); // `${towerId}|${filePath}`
  for (const r of tracked) {
    const towerId = claudeToTower.get(r.session_id);
    if (!towerId) continue;
    const k = `${towerId}|${r.file_path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    insertions.push({
      towerSessionId: towerId,
      filePath: r.file_path,
      tool: r.tool || 'memory.db-backfill',
    });
  }

  console.log(`[backfill] insertion candidates: ${insertions.length}`);

  if (!APPLY) {
    console.log('[backfill] DRY-RUN — rerun with --apply to actually insert.');
    console.log('[backfill] sample (first 5):');
    for (const ins of insertions.slice(0, 5)) {
      console.log(`  - ${ins.towerSessionId.slice(0, 8)} ← ${ins.filePath}`);
    }
    db.close();
    process.exit(0);
  }

  // Bulk insert — one statement per row is fine at this scale (a few thousand
  // max). UNIQUE on (session_id, file_path) makes the operation idempotent.
  let inserted = 0;
  let skipped = 0;
  const t0 = Date.now();
  for (const ins of insertions) {
    try {
      const result = await execute(
        `INSERT INTO session_file_edits (session_id, file_path, tool_name)
           VALUES ($1, $2, $3)
           ON CONFLICT (session_id, file_path) DO NOTHING`,
        [ins.towerSessionId, ins.filePath, ins.tool],
      );
      // execute() returns rowCount via pg-repo; ON CONFLICT skips return 0
      if ((result as any) > 0 || (result as any)?.rowCount > 0) inserted++;
      else skipped++;
    } catch (err) {
      console.warn(`[backfill] insert failed session=${ins.towerSessionId.slice(0, 8)} file=${ins.filePath}: ${(err as Error).message}`);
    }
  }
  const dur = Date.now() - t0;
  console.log(`[backfill] DONE — inserted=${inserted} skipped(already-present)=${skipped} in ${dur}ms`);

  db.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill] FATAL:', err);
  process.exit(1);
});
