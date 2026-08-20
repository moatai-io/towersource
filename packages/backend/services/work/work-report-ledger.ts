/**
 * Owns: extraction of final-answer `Work Summary:` blocks into WorkLedger records.
 * Public API: parseWorkReportBlock(), indexWorkReportMessage().
 *
 * Recent Work should not depend on assistants inventing TodoWrite workstream
 * metadata. This module treats a short visible `Work Summary:` block as the
 * durable work-memory signal and stores only a compact WorkLedger index row.
 * Legacy `업무보고:` blocks remain readable for backward compatibility.
 */

import { createHash } from 'crypto';
import { queryOne } from '../../db/pg-repo.js';
import { upsertWorkLedgerRecord } from './work-ledger.js';

export interface ParsedWorkReport {
  conclusion: string;
  artifacts: string[];
  next: string | null;
  bullets: string[];
}

interface SessionContext {
  project_id: string | null;
  user_id: number | null;
  session_name: string | null;
}

interface MessageContext extends SessionContext {
  session_id: string;
  role: string;
}

function asTextContent(content: unknown): string {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if ((trimmed.startsWith('[') || trimmed.startsWith('{'))) {
      try { return asTextContent(JSON.parse(trimmed)); } catch { /* plain string */ }
    }
    return content;
  }
  if (!Array.isArray(content)) return '';
  return content
    .map((block: any) => {
      if (!block || typeof block !== 'object') return '';
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      // Some persisted shapes use `content` for textual assistant fragments.
      if (typeof block.content === 'string' && (block.type === 'text' || block.type === 'markdown')) return block.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function cleanInlineMarkdown(value: string): string {
  return value
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/^`([^`]+)`$/, '$1')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .trim();
}

function extractField(line: string): { label: string | null; value: string } {
  const cleaned = cleanInlineMarkdown(line);
  const match = cleaned.match(/^([^:：]{1,12})[:：]\s*(.*)$/);
  if (!match) return { label: null, value: cleaned };
  return { label: match[1].trim(), value: match[2].trim() };
}

function extractArtifacts(value: string): string[] {
  const artifacts = new Set<string>();
  const codeMatches = value.match(/`([^`]+)`/g) || [];
  for (const raw of codeMatches) {
    const item = raw.slice(1, -1).trim();
    if (/^(~\/workspace\/|\/home\/[^\s]+\/workspace\/|https?:\/\/|[\w./-]+\.(?:md|ts|tsx|js|json|sql|pdf|xlsx|csv))/.test(item)) artifacts.add(item);
  }
  const pathMatches = value.match(/(?:~\/workspace\/|\/home\/[^\s]+\/workspace\/|https?:\/\/)[^\s`,，)]+|[\w.-]+(?:\/[\w.-]+)+\.(?:md|ts|tsx|js|json|sql|pdf|xlsx|csv)/g) || [];
  for (const item of pathMatches) artifacts.add(item.replace(/[`).,，]+$/, ''));
  return Array.from(artifacts);
}

const REPORT_LABEL_PATTERN = /^\s*(?:#{1,6}\s*)?(?:Work Summary|업무보고)\s*[:：]?\s*$/i;

function normalizeFieldLabel(label: string | null): string {
  return (label || '').replace(/\s+/g, '').toLocaleLowerCase('en-US');
}

/** Parse the final visible `Work Summary:` block (or legacy `업무보고:` block). */
export function parseWorkReportBlock(content: unknown): ParsedWorkReport | null {
  const text = asTextContent(content);
  if (!/Work Summary|업무보고/i.test(text)) return null;

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const labelIndex = lines.findIndex((line) => REPORT_LABEL_PATTERN.test(line));
  if (labelIndex < 0) return null;

  const bullets: string[] = [];
  let sawBullet = false;
  for (const line of lines.slice(labelIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (sawBullet) break;
      continue;
    }
    if (/^#{1,6}\s+/.test(trimmed)) break;
    if (/^[-*]\s+/.test(trimmed)) {
      sawBullet = true;
      bullets.push(cleanInlineMarkdown(trimmed));
      continue;
    }
    if (sawBullet) break;
    // Allow one-line report immediately after the label, but do not consume the
    // rest of a normal final answer as report content.
    bullets.push(cleanInlineMarkdown(trimmed));
    sawBullet = true;
  }

  const compactBullets = bullets.filter(Boolean).slice(0, 8);
  if (compactBullets.length === 0) return null;

  let conclusion = '';
  let next: string | null = null;
  const artifacts = new Set<string>();

  for (const bullet of compactBullets) {
    const { label, value } = extractField(bullet);
    const normalized = normalizeFieldLabel(label);
    if (!conclusion && (!label || ['outcome', 'result', 'summary', 'completed', '결론', '완료', '요약', '결과'].includes(normalized))) conclusion = value || bullet;
    if (!next && ['next', 'nextstep', 'nextsteps', 'followup', '다음', '후속', '남은일'].includes(normalized)) next = value || null;
    if (['artifacts', 'artifact', 'files', 'file', 'links', 'link', '산출물', '파일', '링크'].includes(normalized)) {
      for (const artifact of extractArtifacts(value)) artifacts.add(artifact);
    }
    for (const artifact of extractArtifacts(bullet)) artifacts.add(artifact);
  }

  conclusion ||= compactBullets[0];
  conclusion = conclusion.slice(0, 500).trim();
  if (!conclusion) return null;

  return {
    conclusion,
    artifacts: Array.from(artifacts).slice(0, 20),
    next: next ? next.slice(0, 500).trim() : null,
    bullets: compactBullets,
  };
}

function stableShortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function reportTitle(report: ParsedWorkReport): string {
  return report.conclusion.length > 80 ? `${report.conclusion.slice(0, 77)}…` : report.conclusion;
}

async function sessionContext(sessionId: string): Promise<SessionContext | null> {
  return (await queryOne<SessionContext>(`
    SELECT project_id, user_id, name AS session_name
      FROM sessions
     WHERE id = $1
  `, [sessionId])) ?? null;
}

async function messageContext(messageId: string): Promise<MessageContext | null> {
  return (await queryOne<MessageContext>(`
    SELECT m.session_id, m.role, s.project_id, s.user_id, s.name AS session_name
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
     WHERE m.id = $1
  `, [messageId])) ?? null;
}

async function upsertReport(input: {
  sessionId: string;
  messageId: string;
  content: unknown;
  context: SessionContext;
}): Promise<boolean> {
  const report = parseWorkReportBlock(input.content);
  if (!report) return false;
  const sourceId = `work-report:${input.messageId}`;
  const title = reportTitle(report);
  await upsertWorkLedgerRecord({
    runId: sourceId,
    projectId: input.context.project_id,
    sessionId: input.sessionId,
    ownerUserId: input.context.user_id,
    workstreamKey: `work-report-${stableShortHash(input.messageId)}`,
    workstreamTitle: title,
    runTitle: title,
    outcome: report.conclusion,
    note: report.bullets.join(' / '),
    sourceType: 'manual',
    sourceId,
    sourceRefs: {
      kind: 'work_report',
      parserVersion: 2,
      assistantMessageId: input.messageId,
      sessionName: input.context.session_name || null,
      next: report.next,
    },
    status: 'completed',
    artifacts: report.artifacts,
    backlog: report.next ? [{ type: 'task', title: report.next }] : [],
    todos: [],
  });
  return true;
}

/** Index a just-saved assistant message if it contains a Work Summary block. */
export async function indexWorkReportMessage(input: {
  sessionId: string;
  messageId: string;
  role: string;
  content: unknown;
}): Promise<boolean> {
  if (input.role !== 'assistant') return false;
  const context = await sessionContext(input.sessionId);
  if (!context) return false;
  return await upsertReport({ sessionId: input.sessionId, messageId: input.messageId, content: input.content, context });
}

/** Index a streamed assistant message update if its final content contains a Work Summary block. */
export async function indexWorkReportMessageUpdate(messageId: string, content: unknown): Promise<boolean> {
  const context = await messageContext(messageId);
  if (!context || context.role !== 'assistant') return false;
  return await upsertReport({ sessionId: context.session_id, messageId, content, context });
}
