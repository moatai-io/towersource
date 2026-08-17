/**
 * Backfill session_memory_cards for recent sessions.
 *
 * Dry-run by default. Use --apply to generate cards with the utility mini model.
 *
 * Examples:
 *   npx tsx packages/backend/scripts/backfill-session-memory-cards.ts --project "Tower Development" --user admin --limit 5 --apply
 *   npx tsx packages/backend/scripts/backfill-session-memory-cards.ts --days 14 --limit 20 --apply
 */

import { query } from '../db/pg-repo.js';
import { closePgPool } from '../db/pg.js';
import { refreshSessionMemoryCardIfNeeded } from '../services/ai/session-memory-card.js';

interface CandidateRow {
  id: string;
  name: string;
  username: string | null;
  project_name: string | null;
  turn_count: number;
  updated_at: string;
  has_card: boolean;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const apply = hasFlag('apply');
  const force = hasFlag('force');
  const days = Math.max(1, Number(arg('days') ?? '14'));
  const limit = Math.max(1, Math.min(200, Number(arg('limit') ?? '20')));
  const project = arg('project');
  const user = arg('user');

  const params: any[] = [days, limit];
  const where = [
    `s.archived = 0`,
    `COALESCE(s.turn_count, 0) >= 2`,
    `s.updated_at > now() - ($1::int || ' days')::interval`,
    `EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.role = 'assistant')`,
    `(s.label IS NULL OR s.label NOT IN ('temp', 'autofeed'))`,
  ];
  let idx = 3;
  if (project) {
    where.push(`p.name = $${idx++}`);
    params.push(project);
  }
  if (user) {
    where.push(`u.username = $${idx++}`);
    params.push(user);
  }

  const candidates = await query<CandidateRow>(
    `SELECT s.id, s.name, u.username, p.name AS project_name,
            COALESCE(s.turn_count, 0)::int AS turn_count,
            s.updated_at::text AS updated_at,
            (smc.session_id IS NOT NULL) AS has_card
       FROM sessions s
       LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN projects p ON p.id = s.project_id
       LEFT JOIN session_memory_cards smc ON smc.session_id = s.id
      WHERE ${where.join(' AND ')}
        AND ($${idx}::boolean OR smc.session_id IS NULL)
      ORDER BY s.updated_at DESC
      LIMIT $2`,
    [...params, force],
  );

  console.log(`[backfill-memory-cards] candidates=${candidates.length} apply=${apply} force=${force} days=${days} limit=${limit} project=${project ?? '(any)'} user=${user ?? '(any)'}`);
  for (const [i, c] of candidates.entries()) {
    console.log(`${String(i + 1).padStart(2, '0')}. ${c.updated_at.slice(0, 19)} · ${c.project_name ?? '(no project)'} · ${c.username ?? '?'} · turns=${c.turn_count} · card=${c.has_card ? 'yes' : 'no'} · ${c.name}`);
  }

  if (!apply) {
    console.log('[backfill-memory-cards] dry-run only. Re-run with --apply to generate cards.');
    await closePgPool();
    return;
  }

  const tally = { refreshed: 0, skipped: 0, failed: 0 };
  for (const [i, c] of candidates.entries()) {
    const started = Date.now();
    try {
      const result = await refreshSessionMemoryCardIfNeeded(c.id, { force });
      if (result.refreshed) tally.refreshed++;
      else tally.skipped++;
      console.log(`[${i + 1}/${candidates.length}] ${result.refreshed ? 'refreshed' : 'skipped'} ${c.id.slice(0, 8)} reason=${result.reason} (${Date.now() - started}ms)`);
    } catch (err) {
      tally.failed++;
      console.error(`[${i + 1}/${candidates.length}] failed ${c.id.slice(0, 8)}: ${(err as Error).message}`);
    }
  }

  console.log(`[backfill-memory-cards] done refreshed=${tally.refreshed} skipped=${tally.skipped} failed=${tally.failed}`);
  await closePgPool();
}

main().catch(async (err) => {
  console.error('[backfill-memory-cards] fatal:', err);
  await closePgPool();
  process.exit(1);
});
