/**
 * Reindex persisted assistant Work Summary / 업무보고 blocks into WorkLedger.
 * Dry-run by default. Pass --apply only after reviewing the candidate summary.
 *
 * The canonical sourceId remains work-report:<messageId>, so replay is idempotent.
 */
import { query } from '../db/pg-repo.js';
import { indexWorkReportMessage, parseWorkReportBlock } from '../services/work/work-report-ledger.js';

export type WorkSummaryBackfillExclusion = 'already_indexed' | 'placeholder' | 'too_short' | 'format_example';

export interface WorkSummaryBackfillCandidate {
  messageId: string;
  sessionId: string;
  createdAt: string;
  content: unknown;
  conclusion: string;
  artifactCount: number;
  existing: boolean;
  eligible: boolean;
  exclusion: WorkSummaryBackfillExclusion | null;
}

const PLACEHOLDER_CONCLUSIONS = new Set([
  '무엇을 판단하거나 완료했는가.',
  '무엇을 판단하거나 완료했는가',
  '이어가기',
  'what was decided or completed.',
  'what was decided or completed',
]);

export function classifyWorkSummaryBackfill(report: { conclusion: string; artifacts: string[] }, existing: boolean): WorkSummaryBackfillExclusion | null {
  if (existing) return 'already_indexed';
  const conclusion = report.conclusion.trim();
  if (PLACEHOLDER_CONCLUSIONS.has(conclusion.toLocaleLowerCase('en-US'))) return 'placeholder';
  if (/^(?:예시|example|template|sample)\s*[:：-]/i.test(conclusion)) return 'format_example';
  if (conclusion.length < 12 && report.artifacts.length === 0) return 'too_short';
  return null;
}

function parsePersistedContent(content: unknown): unknown {
  if (typeof content !== 'string') return content;
  try { return JSON.parse(content); } catch { return content; }
}

export async function collectWorkSummaryBackfillCandidates(days: number, limit: number): Promise<WorkSummaryBackfillCandidate[]> {
  const rows = await query<any>(`
    SELECT m.id AS message_id, m.session_id, m.created_at, m.content,
           EXISTS (
             SELECT 1 FROM work_ledger_records w
              WHERE w.run_id = 'work-report:' || m.id
                AND w.source_type = 'manual'
                AND w.source_id = 'work-report:' || m.id
           ) AS existing
      FROM messages m
     WHERE m.role = 'assistant'
       AND m.created_at >= NOW() - ($1::text || ' days')::interval
       AND (m.content ILIKE '%Work Summary%' OR m.content LIKE '%업무보고%')
     ORDER BY m.created_at ASC
     LIMIT $2
  `, [days, limit]);

  return rows.flatMap((row) => {
    const content = parsePersistedContent(row.content);
    const report = parseWorkReportBlock(content);
    if (!report) return [];
    const existing = row.existing === true;
    const exclusion = classifyWorkSummaryBackfill(report, existing);
    return [{
      messageId: row.message_id,
      sessionId: row.session_id,
      createdAt: new Date(row.created_at).toISOString(),
      content,
      conclusion: report.conclusion,
      artifactCount: report.artifacts.length,
      existing,
      eligible: exclusion === null,
      exclusion,
    }];
  });
}

export async function backfillWorkSummaryLedger(args: { days: number; limit: number; apply: boolean }) {
  const candidates = await collectWorkSummaryBackfillCandidates(args.days, args.limit);
  const missing = candidates.filter((candidate) => !candidate.existing);
  const eligible = candidates.filter((candidate) => candidate.eligible);
  const excluded = candidates.filter((candidate) => !candidate.eligible && !candidate.existing);
  let indexed = 0;
  let skipped = 0;

  if (args.apply) {
    for (const candidate of eligible) {
      const result = await indexWorkReportMessage({
        sessionId: candidate.sessionId,
        messageId: candidate.messageId,
        role: 'assistant',
        content: candidate.content,
      });
      if (result) indexed += 1;
      else skipped += 1;
    }
  }

  return {
    mode: args.apply ? 'apply' : 'dry-run',
    days: args.days,
    limit: args.limit,
    candidates: candidates.length,
    existing: candidates.length - missing.length,
    missing: missing.length,
    eligible: eligible.length,
    excluded: excluded.length,
    exclusions: excluded.reduce<Record<string, number>>((counts, candidate) => {
      const reason = candidate.exclusion || 'unknown';
      counts[reason] = (counts[reason] || 0) + 1;
      return counts;
    }, {}),
    indexed,
    skipped,
    preview: eligible.slice(0, 20).map(({ messageId, sessionId, createdAt, conclusion, artifactCount }) => ({
      messageId,
      sessionId,
      createdAt,
      conclusion,
      artifactCount,
      sourceId: `work-report:${messageId}`,
    })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const apply = process.argv.includes('--apply');
  const daysArg = process.argv.find((arg) => arg.startsWith('--days='));
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
  const days = Math.min(Math.max(Number(daysArg?.split('=')[1] || 30), 1), 3650);
  const limit = Math.min(Math.max(Number(limitArg?.split('=')[1] || 5000), 1), 50_000);
  backfillWorkSummaryLedger({ days, limit, apply })
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
