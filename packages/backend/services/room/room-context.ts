/**
 * Room AI Context — 3-Tier context model for @ai in chat rooms.
 *
 * Tier 1: Summaries (always included) — ~500 tok per entry
 * Tier 2: Structured detail (when reference detected) — ~2,000 tok
 * Tier 3: Full data (explicit request only) — 10,000+ tok (future)
 */

// ── Types ─────────────────────────────────────────────────────────

export interface AiContextEntry {
  taskId: string;
  question: string;
  answerSummary: string;
  tokenCount: number;
  createdAt: string;          // ISO string
  expiresAt?: string;         // ISO string, undefined = pinned (no expiry)
  // Tier 2 fields (optional)
  sql?: string;
  sampleRows?: unknown[][];
  schema?: string[];
  rowCount?: number;
}

export interface RecentMessage {
  sender: string;
  content: string;
  timestamp: string;
}

export interface RoomContextConfig {
  maxTier1Count: number;      // max number of Tier 1 summaries
  maxTier1Tokens: number;     // token budget for Tier 1
  maxTier2Tokens: number;     // token budget for Tier 2
  maxRecentMessages: number;  // max recent chat messages to include
  maxTotalTokens: number;     // total context token budget
}

export interface AssembleInput {
  roomName: string;
  roomDescription: string;
  aiContextEntries: AiContextEntry[];
  recentMessages: RecentMessage[];
  userPrompt: string;
  config: RoomContextConfig;
}

// ── Reference Detection ───────────────────────────────────────────

const REFERENCE_PATTERNS = [
  // Korean
  /이\s*중에서/,
  /위\s*결과/,
  /아까/,
  /이전\s*(분석|결과|태스크|데이터)/,
  /방금/,
  /그\s*결과/,
  // English
  /from the above/i,
  /those results/i,
  /previous (analysis|results|task|data)/i,
  /based on (the |that )?(above|previous|last)/i,
  /the above/i,
];

export function detectContextReference(prompt: string): { hasReference: boolean } {
  for (const pattern of REFERENCE_PATTERNS) {
    if (pattern.test(prompt)) {
      return { hasReference: true };
    }
  }
  return { hasReference: false };
}

// ── Tier 1: Summary Selection ─────────────────────────────────────

export function buildTier1Summary(
  entries: AiContextEntry[],
  maxCount: number,
): AiContextEntry[] {
  return [...entries]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, maxCount);
}

// ── Tier 2: Detail for Referenced Task ────────────────────────────

export function buildTier2Detail(
  entries: AiContextEntry[],
  taskId: string | undefined,
): AiContextEntry | null {
  if (taskId) {
    return entries.find(e => e.taskId === taskId) ?? null;
  }
  // Default: most recent entry with detail data
  const sorted = [...entries]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return sorted[0] ?? null;
}

// ── Token Budget ──────────────────────────────────────────────────

export function truncateToTokenBudget(
  entries: AiContextEntry[],
  budget: number,
): AiContextEntry[] {
  const result: AiContextEntry[] = [];
  let used = 0;
  for (const entry of entries) {
    if (used + entry.tokenCount > budget) break;
    result.push(entry);
    used += entry.tokenCount;
  }
  return result;
}

// ── Expiry Filter ─────────────────────────────────────────────────

export function filterExpiredContexts(
  entries: AiContextEntry[],
  nowMs: number,
): AiContextEntry[] {
  return entries.filter(e => {
    if (!e.expiresAt) return true; // no expiry = pinned
    return new Date(e.expiresAt).getTime() > nowMs;
  });
}

// ── Full Context Assembly ─────────────────────────────────────────

export function assembleRoomBackgroundContext(input: AssembleInput): string {
  const { roomName, roomDescription, aiContextEntries, recentMessages, userPrompt, config } = input;
  const parts: string[] = [];

  // Room header
  parts.push(`[Room: ${roomName}]`);
  if (roomDescription) {
    parts.push(roomDescription);
  }

  // Filter expired
  const validEntries = filterExpiredContexts(aiContextEntries, Date.now());

  // Tier 1: Recent summaries
  const tier1 = buildTier1Summary(validEntries, config.maxTier1Count);
  const tier1Budgeted = truncateToTokenBudget(tier1, config.maxTier1Tokens);

  if (tier1Budgeted.length > 0) {
    parts.push('');
    parts.push('[이전 태스크 요약]');
    for (const entry of tier1Budgeted) {
      parts.push(`- Task ${entry.taskId}: ${entry.question} → ${entry.answerSummary}`);
    }
  }

  // Tier 2: Detail (only if reference detected)
  const { hasReference } = detectContextReference(userPrompt);
  if (hasReference && validEntries.length > 0) {
    const detail = buildTier2Detail(validEntries, undefined);
    if (detail?.sql) {
      parts.push('');
      parts.push('[참조 데이터 상세]');
      parts.push(`Task ${detail.taskId}:`);
      parts.push(`SQL: ${detail.sql}`);
      if (detail.schema) {
        parts.push(`Schema: ${detail.schema.join(', ')}`);
      }
      if (detail.sampleRows && detail.sampleRows.length > 0) {
        parts.push(`Sample (${detail.rowCount ?? '?'} rows total):`);
        for (const row of detail.sampleRows.slice(0, 5)) {
          parts.push(`  ${JSON.stringify(row)}`);
        }
      }
    }
  }

  // Recent messages
  if (recentMessages.length > 0) {
    const recent = recentMessages.slice(-config.maxRecentMessages);
    parts.push('');
    parts.push('[최근 대화]');
    for (const msg of recent) {
      parts.push(`${msg.sender} (${msg.timestamp}): ${msg.content}`);
    }
  }

  return parts.join('\n');
}

export function assembleRoomContext(input: AssembleInput): string {
  const background = assembleRoomBackgroundContext(input);
  return [background, '', '[질문]', input.userPrompt].filter(Boolean).join('\n');
}
