// Owns Pi session-file rescue when SDK compaction succeeds but the resumed
// branch still includes too much kept history.
// Public API: createPiCompactRecoverySessionFile, isPiContextLengthExceededMessage.

import crypto from 'node:crypto';
import { getModelDefaults } from '../../config.js';
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
import { sanitizeEmbeddedBinaryText } from '../../services/content-safety/embedded-binary.js';

type SessionLike = {
  getHeader(): any;
  getEntries(): any[];
  getSessionFile(): string | undefined;
  getSessionDir(): string;
};

type MutableSessionLike = SessionLike & {
  getBranch(): any[];
  appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number, details?: any, fromHook?: boolean): string;
  buildSessionContext?: () => { messages: any[] };
};

// A real 959k-token demo-org incident lived in only ~9.1MB of text-heavy JSONL.
// File size is therefore a startup-risk proxy, not a binary-bloat threshold.
export const PI_OVERSIZED_RESUME_FILE_BYTES = 8 * 1024 * 1024;
const MAX_STREAMED_RECOVERY_LINE_BYTES = 4 * 1024 * 1024;
const MAX_STREAMED_RECENT_EXCERPTS = 24;
const MAX_STREAMED_EXCERPT_CHARS = 1_200;
export const PI_REPEATED_LOCAL_FALLBACK_LIMIT = 2;
const LOCAL_FALLBACK_MARKER = '"localFallback":true';

export function isPiContextLengthExceededMessage(message: unknown): boolean {
  return /Pi Responses preflight rejected near-context request before upstream send|preflightFloor=|context_length_exceeded/i.test(String(message || ''));
}

/**
 * Compaction uses the same provider transport as an ordinary turn. If the
 * compaction request itself is rejected for context size, retrying provider
 * compaction cannot make progress; Tower must switch to its bounded local
 * compaction instead of bubbling the same overflow back into the recovery loop.
 */
export function shouldUsePiLocalFallbackAfterCompactionError(message: unknown): boolean {
  return isPiContextLengthExceededMessage(message);
}

export function countPiLocalFallbackMarkersInFile(filePath: string, stopAfter = Number.POSITIVE_INFINITY): number {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count = 0;
    let carry = '';
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      const text = carry + buffer.toString('utf8', 0, bytesRead);
      let index = 0;
      while ((index = text.indexOf(LOCAL_FALLBACK_MARKER, index)) >= 0) {
        count++;
        if (count >= stopAfter) return count;
        index += LOCAL_FALLBACK_MARKER.length;
      }
      carry = text.slice(-LOCAL_FALLBACK_MARKER.length);
    }
    return count;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best-effort */ }
  }
}

export function shouldCreatePiOversizedRecoveryEpoch(filePath: string, thresholdBytes = PI_OVERSIZED_RESUME_FILE_BYTES): boolean {
  try {
    if (fs.statSync(filePath).size >= Math.max(1, thresholdBytes)) return true;
    // Repeated local fallback summaries are evidence that provider-backed
    // compaction is not reducing the authoritative request. Escalate on the
    // next resume instead of appending another ineffective boundary forever.
    return countPiLocalFallbackMarkersInFile(filePath, PI_REPEATED_LOCAL_FALLBACK_LIMIT) >= PI_REPEATED_LOCAL_FALLBACK_LIMIT;
  } catch {
    return false;
  }
}

/** Parse authoritative Responses preflight measurements carried in provider errors. */
export function parsePiPreflightContextMetrics(message: unknown): { bodyTokens: number; contextWindow: number; safeTargetTokens: number } | null {
  const text = String(message || '');
  const bodyTokens = Number(text.match(/bodyEstimatedPromptTokens=(\d+)/)?.[1] || 0);
  const contextWindow = Number(text.match(/context=(\d+)/)?.[1] || 0);
  if (!bodyTokens || !contextWindow) return null;
  return { bodyTokens, contextWindow, safeTargetTokens: Math.floor(contextWindow * 0.5) };
}

/** Recent-history budgets for finite 15% → 5% recovery escalation. */
export function piRecoveryKeepBudgets(contextWindow: number): [number, number] {
  const window = Math.max(32_000, Number(contextWindow) || 0);
  return [Math.max(8_000, Math.floor(window * 0.15)), Math.max(8_000, Math.floor(window * 0.05))];
}

const MAX_RECOVERY_TEXT_CHARS = 16_000;
const MAX_RECOVERY_TOOL_RESULT_CHARS = 4_000;
const MAX_RECOVERY_TOOL_INPUT_CHARS = 2_000;

function capRecoveryText(text: string, maxChars: number): string {
  const sanitized = sanitizeEmbeddedBinaryText(text);
  return truncateMiddle(sanitized, maxChars);
}

/** Build an LLM-safe copy of retained context; never mutates source entries or files. */
export function sanitizePiMessagesForRecovery(messages: any[]): any[] {
  return (Array.isArray(messages) ? messages : []).map((message: any) => {
    const content = Array.isArray(message?.content) ? message.content.map((part: any) => {
      if (part?.type === 'text') return { ...part, text: capRecoveryText(String(part.text || ''), MAX_RECOVERY_TEXT_CHARS) };
      if (part?.type === 'toolCall') return { ...part, arguments: { omitted: true, preview: capRecoveryText(JSON.stringify(part.arguments || {}), MAX_RECOVERY_TOOL_INPUT_CHARS) } };
      if (part?.type === 'image') return { type: 'text', text: `[image omitted during context recovery: ${part.mimeType || 'unknown'}]` };
      return part;
    }) : message?.content;
    if (message?.role === 'toolResult') {
      const safeContent = Array.isArray(content) ? content.map((part: any) => part?.type === 'text'
        ? { ...part, text: capRecoveryText(String(part.text || ''), MAX_RECOVERY_TOOL_RESULT_CHARS) }
        : { type: 'text', text: '[binary tool result omitted during context recovery]' }) : content;
      return { ...message, content: safeContent };
    }
    return { ...message, content };
  });
}

/** Persist recovery edits on canonical SDKs; retain the 0.82 compatibility path. */
export function refreshPiRecoveryContext(manager: any, agent: any, refreshContext?: () => void): void {
  if (typeof manager?.buildSessionProjection === 'function' && typeof manager?.appendContextEdit === 'function') {
    if (!refreshContext) throw new Error('Canonical Pi recovery requires AgentSession.refreshContext');
    for (const entry of manager.buildSessionProjection().entries) {
      // Only edit single persisted messages, not generated compaction summaries.
      if (entry.sourceEntry?.type !== 'message' || entry.messages.length !== 1) continue;
      const message = entry.messages[0];
      if (!['user', 'assistant', 'toolResult'].includes(message.role)) continue;
      const safe = sanitizePiMessagesForRecovery([message])[0];
      // Historical tool arguments are execution evidence, not disposable text.
      // Preserve them exactly; repeatedly wrapping them would also grow edits.
      if (Array.isArray(message.content)) {
        safe.content = safe.content.map((part: any, index: number) =>
          message.content[index]?.type === 'toolCall' ? message.content[index] : part);
      }
      if (JSON.stringify(safe.content) !== JSON.stringify(message.content)) {
        manager.appendContextEdit(entry.sourceEntry.id, { content: safe.content });
      }
    }
    refreshContext();
    return;
  }
  if (agent?.state && typeof manager?.buildSessionContext === 'function') {
    agent.state.messages = sanitizePiMessagesForRecovery(manager.buildSessionContext().messages);
  }
}

function shortId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`.slice(0, 12);
}

function safeTimestamp(): string {
  return new Date().toISOString();
}

function compactTimestampForFile(ts: string): string {
  return ts.replace(/[:.]/g, '-');
}

export function countPiCompactionEntries(session: SessionLike | null | undefined): number {
  try {
    const entries = session?.getEntries?.() || [];
    return entries.filter((entry: any) => entry?.type === 'compaction').length;
  } catch {
    return 0;
  }
}

function entryText(entry: any): string {
  const msg = entry?.message;
  if (!msg) return '';
  const parts = Array.isArray(msg.content) ? msg.content : [];
  const text = parts.map((part: any) => {
    if (part?.type === 'text') return part.text || '';
    if (part?.type === 'tool_use') return `[tool_use:${part.name || 'tool'}] ${JSON.stringify(part.input || {}).slice(0, 500)}`;
    if (part?.type === 'tool_result') return `[tool_result] ${String(part.content || part.result || '').slice(0, 800)}`;
    return '';
  }).filter(Boolean).join('\n');
  return text.trim();
}

function estimateEntryTokens(entry: any): number {
  try {
    if (entry?.message) return estimateTokens(entry.message as any);
    return estimateTokens(entry as any);
  } catch {
    return Math.ceil(JSON.stringify(entry || {}).length / 4);
  }
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n…[truncated ${text.length - maxChars} chars]…\n${text.slice(-tail)}`;
}

function buildLocalFallbackSummary(params: {
  branch: any[];
  firstKeptIndex: number;
  reason: string;
  tokensBefore: number;
  keepRecentTokens: number;
}): string {
  const { branch, firstKeptIndex, reason, tokensBefore, keepRecentTokens } = params;
  const droppedMessages = branch
    .slice(0, firstKeptIndex)
    .filter((entry: any) => entry?.type === 'message' && entryText(entry));
  const highlights = droppedMessages
    .slice(-80)
    .map((entry: any) => {
      const role = entry?.message?.role || 'message';
      const text = truncateMiddle(entryText(entry).replace(/\s+/g, ' '), 700);
      return `- ${role}: ${text}`;
    })
    .join('\n');

  return truncateMiddle([
    '## Tower local fallback compaction',
    '',
    'Pi SDK reported that compaction finished but did not persist a usable compaction result. Tower generated this local recovery summary to break the repeated compact loop.',
    '',
    `Reason: ${reason.slice(0, 500)}`,
    `Estimated tokens before compaction: ${tokensBefore}`,
    `Retained recent-history budget: ${keepRecentTokens}`,
    '',
    '## Older conversation highlights',
    highlights || '- No text highlights were recoverable from the dropped prefix.',
    '',
    '## Continuation guidance',
    '- Treat the retained recent messages after this compaction boundary as the source of truth.',
    '- If exact old details are needed, ask the user or inspect project files/logs instead of relying on dropped transcript text.',
  ].join('\n'), 24_000);
}

export type PiOverflowCompactionRecoveryResult = {
  mode: 'provider' | 'local-fallback';
  compactionCountBefore: number;
  compactionCountAfter: number;
  providerError?: string;
  localFallback?: ReturnType<typeof createPiLocalFallbackCompaction>;
};

/**
 * Execute the complete compaction decision used after a provider preflight
 * overflow. This boundary is intentionally independent from PiEngine so the
 * representative failure sequence can be exercised with a real session-like
 * branch instead of source-regex tests.
 */
export function shouldReplayPiOverflowPrompt(params: {
  assistantSaved: boolean;
  toolCallsExecuted: number;
  abortRequested: boolean;
}): boolean {
  return !params.assistantSaved && params.toolCallsExecuted === 0 && !params.abortRequested;
}

export async function recoverPiOverflowCompaction(params: {
  session: MutableSessionLike | null | undefined;
  agent?: { state?: { messages?: any[] } } | null;
  refreshContext?: () => void;
  compact: () => Promise<unknown>;
  keepRecentTokens: number;
  compactionCountBefore?: number;
}): Promise<PiOverflowCompactionRecoveryResult> {
  const before = params.compactionCountBefore ?? countPiCompactionEntries(params.session);
  let providerError = '';
  try {
    await params.compact();
  } catch (err: any) {
    providerError = err?.message || String(err || 'unknown compaction error');
    if (!shouldUsePiLocalFallbackAfterCompactionError(providerError)) throw err;
  }

  const afterProvider = countPiCompactionEntries(params.session);
  if (!providerError && afterProvider > before) {
    return { mode: 'provider', compactionCountBefore: before, compactionCountAfter: afterProvider };
  }

  const localFallback = createPiLocalFallbackCompaction({
    session: params.session,
    agent: params.agent,
    refreshContext: params.refreshContext,
    reason: providerError
      ? `provider compaction failed before persistence: ${providerError}`
      : 'manual oversized-preflight recovery compact() returned without persisting a compaction entry',
    keepRecentTokens: params.keepRecentTokens,
  });
  if (!localFallback.succeeded) {
    throw new Error(`Pi compact() did not produce a usable compaction; local fallback failed: ${localFallback.reason || 'unknown'}`);
  }
  return {
    mode: 'local-fallback',
    compactionCountBefore: before,
    compactionCountAfter: localFallback.after,
    ...(providerError ? { providerError } : {}),
    localFallback,
  };
}

export function createPiLocalFallbackCompaction(params: {
  session: MutableSessionLike | null | undefined;
  agent?: { state?: { messages?: any[] } } | null;
  reason: string;
  refreshContext?: () => void;
  keepRecentTokens?: number;
}): { succeeded: boolean; compactionId?: string; before: number; after: number; firstKeptEntryId?: string; reason?: string } {
  const { session, agent, reason } = params;
  const before = countPiCompactionEntries(session);
  try {
    const branch = session?.getBranch?.() || [];
    if (branch.length === 0) return { succeeded: false, before, after: before, reason: 'empty branch' };
    if (branch[branch.length - 1]?.type === 'compaction') {
      return { succeeded: false, before, after: before, reason: 'latest entry is already compaction' };
    }

    const keepRecentTokens = Math.max(8_000, Number(params.keepRecentTokens || process.env.PI_LOCAL_FALLBACK_COMPACTION_KEEP_RECENT_TOKENS) || 60_000);
    let suffixTokens = 0;
    let firstKeptIndex = branch.length - 1;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry?.type === 'session' || entry?.type === 'model_change' || entry?.type === 'thinking_level_change') break;
      const nextTokens = estimateEntryTokens(entry);
      if (suffixTokens > 0 && suffixTokens + nextTokens > keepRecentTokens) break;
      suffixTokens += nextTokens;
      firstKeptIndex = i;
    }

    const firstKeptEntry = branch[firstKeptIndex];
    if (!firstKeptEntry?.id || firstKeptIndex <= 0) {
      return { succeeded: false, before, after: before, reason: 'no useful prefix to compact' };
    }

    const tokensBefore = branch.reduce((sum: number, entry: any) => sum + estimateEntryTokens(entry), 0);
    const summary = buildLocalFallbackSummary({ branch, firstKeptIndex, reason, tokensBefore, keepRecentTokens });
    const compactionId = session!.appendCompaction(
      summary,
      firstKeptEntry.id,
      tokensBefore,
      { localFallback: true, reason: reason.slice(0, 500), keepRecentTokens, suffixTokens },
      false,
    );
    refreshPiRecoveryContext(session, agent, params.refreshContext);
    const after = countPiCompactionEntries(session);
    return { succeeded: after > before, compactionId, before, after, firstKeptEntryId: firstKeptEntry.id };
  } catch (err: any) {
    return { succeeded: false, before, after: countPiCompactionEntries(session), reason: err?.message || String(err) };
  }
}

type StreamedRecoveryState = {
  header?: any;
  latestCompaction?: any;
  latestModelChange?: any;
  latestThinkingChange?: any;
  recentExcerpts: string[];
  skippedOversizedLines: number;
  scannedLines: number;
};

function safeRecoveryExcerpt(entry: any): string {
  if (entry?.type !== 'message' || !entry.message) return '';
  const role = String(entry.message.role || 'message');
  const content = Array.isArray(entry.message.content) ? entry.message.content : [];
  const text = content.map((part: any) => {
    if (part?.type === 'text') return capRecoveryText(String(part.text || ''), MAX_STREAMED_EXCERPT_CHARS);
    if (part?.type === 'toolCall') return `[tool call omitted: ${part.name || 'tool'}]`;
    if (part?.type === 'image') return `[image omitted: ${part.mimeType || 'unknown'}]`;
    return '';
  }).filter(Boolean).join(' ');
  return text ? `- ${role}: ${truncateMiddle(text.replace(/\s+/g, ' '), MAX_STREAMED_EXCERPT_CHARS)}` : '';
}

/**
 * Scan a JSONL session incrementally. Oversized lines are never JSON.parse'd,
 * preventing one multi-megabyte image/tool entry from becoming another large JS
 * object graph during startup recovery.
 */
async function scanPiSessionForBoundedRecovery(sourceFile: string): Promise<StreamedRecoveryState> {
  const readline = await import('node:readline');
  const input = fs.createReadStream(sourceFile, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  const state: StreamedRecoveryState = { recentExcerpts: [], skippedOversizedLines: 0, scannedLines: 0 };
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    state.scannedLines++;
    if (!line || Buffer.byteLength(line) > MAX_STREAMED_RECOVERY_LINE_BYTES) {
      if (line) state.skippedOversizedLines++;
      continue;
    }
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type === 'session' && !state.header) state.header = entry;
    if (entry?.type === 'model_change') state.latestModelChange = entry;
    if (entry?.type === 'thinking_level_change') state.latestThinkingChange = entry;
    if (entry?.type === 'compaction' && typeof entry.summary === 'string' && entry.summary.trim()) state.latestCompaction = entry;
    const excerpt = safeRecoveryExcerpt(entry);
    if (excerpt) {
      state.recentExcerpts.push(excerpt);
      if (state.recentExcerpts.length > MAX_STREAMED_RECENT_EXCERPTS) state.recentExcerpts.shift();
    }
  }
  return state;
}

/** Create a small new epoch without opening the oversized source SessionManager. */
export async function createPiOversizedRecoveryEpochFromFile(sourceFile: string, reason: string): Promise<string | null> {
  const state = await scanPiSessionForBoundedRecovery(sourceFile);
  const header = state.header;
  if (!header) return null;
  const sessionDir = path.dirname(sourceFile);
  const timestamp = safeTimestamp();
  const recoveryId = crypto.randomUUID();
  const outputFile = path.join(sessionDir, `${compactTimestampForFile(timestamp)}_${recoveryId}_oversized-recovery.jsonl`);
  const summary = truncateMiddle([
    '## Tower oversized session recovery',
    '',
    'The prior Pi session exceeded Tower’s safe startup-memory budget. Tower started a bounded recovery epoch instead of loading and duplicating the full JSONL in memory.',
    '',
    `Reason: ${reason.slice(0, 500)}`,
    `Original session file: ${sourceFile}`,
    `Scanned JSONL lines: ${state.scannedLines}`,
    `Skipped oversized lines: ${state.skippedOversizedLines}`,
    '',
    '## Latest prior compaction summary',
    state.latestCompaction?.summary || 'No usable prior compaction summary was found.',
    '',
    '## Recent bounded excerpts',
    state.recentExcerpts.join('\n') || '- No bounded text excerpts were recoverable.',
    '',
    '## Continuation guidance',
    '- Treat this as a lossy emergency epoch. Verify exact old details from project files or the persisted Tower transcript.',
    '- Large images and tool payloads were deliberately not loaded into memory.',
  ].join('\n'), 32_000);
  const modelId = shortId('m_');
  const thinkingId = shortId('t_');
  const compactId = shortId('c_');
  const recoveredEntries = [
    { ...header, id: recoveryId, version: 3, timestamp, parentSession: sourceFile, cwd: header.cwd },
    { type: 'model_change', id: modelId, parentId: null, timestamp, provider: state.latestModelChange?.provider || 'litellm-responses', modelId: state.latestModelChange?.modelId || getModelDefaults().session.split('/').slice(1).join('/') },
    { type: 'thinking_level_change', id: thinkingId, parentId: modelId, timestamp, thinkingLevel: state.latestThinkingChange?.thinkingLevel || 'medium' },
    { type: 'compaction', id: compactId, parentId: thinkingId, timestamp, summary, firstKeptEntryId: compactId, tokensBefore: state.latestCompaction?.tokensBefore || 0, details: { oversizedRecovery: true, recoveredFrom: sourceFile, skippedOversizedLines: state.skippedOversizedLines, scannedLines: state.scannedLines }, fromHook: false },
  ];
  fs.writeFileSync(outputFile, `${recoveredEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return outputFile;
}

function findLatestCompaction(entries: any[]): any | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === 'compaction' && typeof entry.summary === 'string' && entry.summary.trim()) {
      return entry;
    }
  }
  return undefined;
}

function findLatestBefore(entries: any[], type: string, beforeTimestamp: string): any | undefined {
  let latest: any | undefined;
  for (const entry of entries) {
    if (entry?.type !== type) continue;
    if (beforeTimestamp && String(entry.timestamp || '') > beforeTimestamp) continue;
    latest = entry;
  }
  return latest;
}

/**
 * Build a new minimal Pi JSONL session file from the latest compaction summary.
 *
 * Why this exists: Pi SDK compaction keeps `firstKeptEntryId` history after the
 * summary. In pathological sessions the kept branch may still contain huge
 * assistant/tool/reasoning entries, so the next provider request remains
 * oversized and compact loops forever. A recovery file deliberately keeps only
 * the summary + model settings, making the next turn resume from the compacted
 * state instead of replaying the oversized branch.
 */
export function createPiCompactRecoverySessionFile(session: SessionLike, reason: string): string | null {
  const header = session.getHeader?.();
  const sourceFile = session.getSessionFile?.();
  const sessionDir = session.getSessionDir?.();
  if (!header || !sourceFile || !sessionDir) return null;

  const entries = session.getEntries?.() || [];
  const compaction = findLatestCompaction(entries);
  if (!compaction) return null;

  fs.mkdirSync(sessionDir, { recursive: true });
  const timestamp = safeTimestamp();
  const recoverySessionId = header.id || crypto.randomUUID();
  const outputFile = path.join(
    sessionDir,
    `${compactTimestampForFile(timestamp)}_${recoverySessionId}_compact-recovery.jsonl`,
  );

  const modelChange = findLatestBefore(entries, 'model_change', compaction.timestamp);
  const thinkingChange = findLatestBefore(entries, 'thinking_level_change', compaction.timestamp);

  const modelId = shortId('m_');
  const thinkingId = shortId('t_');
  const compactId = shortId('c_');

  const recoveryNote = [
    '',
    '---',
    '',
    '## Pi compact recovery note',
    `This session was recovered because compacted resume still exceeded context.`,
    `Reason: ${reason.slice(0, 500)}`,
    `Original session file: ${sourceFile}`,
    `Original compaction id: ${compaction.id || 'unknown'}`,
  ].join('\n');

  const recoveredEntries: any[] = [
    {
      ...header,
      version: 3,
      timestamp: header.timestamp || timestamp,
      cwd: header.cwd,
    },
    {
      type: 'model_change',
      id: modelId,
      parentId: null,
      timestamp,
      provider: modelChange?.provider || 'litellm-responses',
      modelId: modelChange?.modelId || getModelDefaults().session.split('/').slice(1).join('/'),
    },
    {
      type: 'thinking_level_change',
      id: thinkingId,
      parentId: modelId,
      timestamp,
      thinkingLevel: thinkingChange?.thinkingLevel || 'medium',
    },
    {
      type: 'compaction',
      id: compactId,
      parentId: thinkingId,
      timestamp,
      summary: `${compaction.summary}${recoveryNote}`,
      // Intentionally points to itself so buildSessionContext emits summary only
      // and no pre-compaction kept branch.
      firstKeptEntryId: compactId,
      tokensBefore: compaction.tokensBefore,
      details: {
        ...(compaction.details || {}),
        recoveredFrom: sourceFile,
        sourceCompactionId: compaction.id,
        recoveryReason: reason.slice(0, 500),
      },
      fromHook: false,
    },
  ];

  fs.writeFileSync(
    outputFile,
    `${recoveredEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  );
  return outputFile;
}
