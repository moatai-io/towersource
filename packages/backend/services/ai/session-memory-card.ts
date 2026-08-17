/**
 * session-memory-card.ts
 *
 * Owns: one-per-session continuity cards for Pi startup memory.
 * Public API: refreshSessionMemoryCardIfNeeded(), getMemoryCardsForContext().
 *
 * Cards are personal by default: same user + same project. They are not project
 * memory; project/team memory will be a separate curated layer.
 * See: workspace/decisions/2026-06-09-session-continuity-cards.md
 */

import { getModelDefaults } from '../../config.js';
import { query, queryOne } from '../../db/pg-repo.js';
import { extractTextFromContent } from '../../utils/text.js';
import { runUtilityTextTask } from './utility-agent.js';

const CARD_VERSION = 1;
const MIN_TURNS_TO_GENERATE = 2;
const TURN_REFRESH_DELTA = 10;
const TIME_REFRESH_MS = 60 * 60 * 1000;
const DUE_SCAN_INTERVAL_MS = 5 * 60 * 1000;
const DUE_SCAN_BATCH_LIMIT = 20;
const MAX_TEXT_CHARS = 18_000;
const MAX_FIELD = 5;
const GENERATION_TIMEOUT_MS = 45_000;

const activeRefreshes = new Set<string>();

export interface SessionMemoryCard {
  session_id: string;
  user_id: number;
  project_id: string | null;
  title: string | null;
  outcome: string | null;
  pain_points: string[];
  resolved: string[];
  steps_taken: string[];
  next_actions: string[];
  artifacts: string[];
  decisions: string[];
  cautions: string[];
  touched_files: string[];
  covered_turn_count: number;
  covered_message_id: string | null;
  covered_message_created_at: string | null;
  model: string | null;
  confidence: string | null;
  revision: number;
  updated_at: string;
  /** Effective date for UX/ranking: session activity time, not card refresh/backfill time. */
  memory_date?: string | null;
}

interface SessionMetaRow {
  id: string;
  name: string;
  user_id: number | null;
  project_id: string | null;
  project_name: string | null;
  turn_count: number | null;
  archived: number | null;
  label: string | null;
}

interface ExistingCardRow {
  covered_turn_count: number;
  covered_message_id: string | null;
  updated_at: string;
  revision: number;
}

interface MessageRow {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

interface FileRow {
  file_path: string;
  tool_name: string | null;
  created_at: string;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim())
    .slice(0, MAX_FIELD);
}

const ROUTINE_OPERATIONAL_MEMORY = /(push|푸시|dirty|working tree|origin\/main|커밋|commit|사용자 요청|요청이 없어|범위 밖|건드리지 않|typecheck|tsc|vitest|테스트 통과|파일 경로|절대경로)/i;

function dropRoutineOperational(items: string[]): string[] {
  return items.filter((item) => !ROUTINE_OPERATIONAL_MEMORY.test(item)).slice(0, MAX_FIELD);
}

function normalizeCard(raw: any, fallbackTitle: string, touchedFiles: string[]) {
  return {
    title: typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 180) : fallbackTitle,
    outcome: typeof raw?.outcome === 'string' ? raw.outcome.trim().slice(0, 700) : '',
    pain_points: asStringArray(raw?.pain_points),
    resolved: asStringArray(raw?.resolved),
    steps_taken: asStringArray(raw?.steps_taken),
    next_actions: asStringArray(raw?.next_actions),
    artifacts: asStringArray(raw?.artifacts),
    decisions: dropRoutineOperational(asStringArray(raw?.decisions)),
    cautions: dropRoutineOperational(asStringArray(raw?.cautions)),
    touched_files: uniqueBasenames(asStringArray(raw?.touched_files).length > 0 ? asStringArray(raw?.touched_files) : touchedFiles).slice(0, MAX_FIELD),
    confidence: ['high', 'medium', 'low'].includes(raw?.confidence) ? raw.confidence : 'medium',
  };
}

function parseJsonObject(text: string): any | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed.match(/\{[\s\S]*\}/)?.[0] || trimmed;
  try { return JSON.parse(candidate); } catch { return null; }
}

function compactLines(text: string, max = 900): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

function isUsefulText(text: string): boolean {
  if (!text.trim()) return false;
  if (text.includes('\u0000')) return false;
  return true;
}

function uniqueBasenames(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const base = p.split('/').filter(Boolean).pop() || p;
    if (!base || ['src', 'packages', 'backend', 'frontend', 'workspace', 'tower'].includes(base)) continue;
    if (seen.has(base)) continue;
    seen.add(base);
    out.push(base);
  }
  return out;
}

async function loadSessionMeta(sessionId: string): Promise<SessionMetaRow | undefined> {
  return queryOne<SessionMetaRow>(
    `SELECT s.id, s.name, s.user_id, s.project_id, p.name AS project_name,
            s.turn_count, s.archived, s.label
       FROM sessions s
       LEFT JOIN projects p ON p.id = s.project_id
      WHERE s.id = $1`,
    [sessionId],
  );
}

async function loadLastAssistant(sessionId: string): Promise<MessageRow | undefined> {
  return queryOne<MessageRow>(
    `SELECT id, role, content, created_at::text AS created_at
       FROM messages
      WHERE session_id = $1
        AND role = 'assistant'
        AND COALESCE(metadata->>'hidden', '') = ''
      ORDER BY created_at DESC
      LIMIT 1`,
    [sessionId],
  );
}

async function loadRecentMessages(sessionId: string): Promise<MessageRow[]> {
  const rows = await query<MessageRow>(
    `SELECT id, role, content, created_at::text AS created_at
       FROM (
         SELECT id, role, content, created_at
           FROM messages
          WHERE session_id = $1
            AND role IN ('user', 'assistant')
            AND COALESCE(metadata->>'hidden', '') = ''
          ORDER BY created_at DESC
          LIMIT 24
       ) sub
      ORDER BY created_at ASC`,
    [sessionId],
  );
  return rows;
}

async function loadTouchedFiles(sessionId: string): Promise<FileRow[]> {
  return query<FileRow>(
    `SELECT file_path, tool_name, created_at::text AS created_at
       FROM session_file_edits
      WHERE session_id = $1
        AND tool_name IN ('Edit','Write','NotebookEdit','edit','write')
      ORDER BY created_at DESC
      LIMIT 30`,
    [sessionId],
  );
}

async function shouldRefresh(meta: SessionMetaRow): Promise<{ ok: boolean; reason: string; existing?: ExistingCardRow; lastAssistant?: MessageRow }> {
  if (!meta.user_id) return { ok: false, reason: 'no-user' };
  if (meta.archived) return { ok: false, reason: 'archived' };
  // `temp` is the normal label for many active sidebar sessions, so it must
  // still get continuity memory. Skip only non-conversational/system feeds.
  if (meta.label && ['autofeed', 'task'].includes(meta.label)) return { ok: false, reason: `label:${meta.label}` };
  const turnCount = meta.turn_count ?? 0;
  if (turnCount < MIN_TURNS_TO_GENERATE) return { ok: false, reason: 'too-few-turns' };

  const lastAssistant = await loadLastAssistant(meta.id);
  if (!lastAssistant) return { ok: false, reason: 'no-assistant' };

  const existing = await queryOne<ExistingCardRow>(
    `SELECT covered_turn_count, covered_message_id, updated_at::text AS updated_at, revision
       FROM session_memory_cards
      WHERE session_id = $1`,
    [meta.id],
  );

  if (!existing) return { ok: true, reason: 'missing-card', lastAssistant };
  if (existing.covered_message_id === lastAssistant.id && turnCount <= existing.covered_turn_count) {
    return { ok: false, reason: 'no-new-activity', existing, lastAssistant };
  }
  if (turnCount >= existing.covered_turn_count + TURN_REFRESH_DELTA) {
    return { ok: true, reason: 'turn-delta', existing, lastAssistant };
  }
  const ageMs = Date.now() - new Date(existing.updated_at).getTime();
  if (ageMs >= TIME_REFRESH_MS && existing.covered_message_id !== lastAssistant.id) {
    return { ok: true, reason: 'time-delta-with-activity', existing, lastAssistant };
  }
  return { ok: false, reason: 'fresh-enough', existing, lastAssistant };
}

function fallbackFromLastAssistant(meta: SessionMetaRow, messages: MessageRow[], touched: string[]) {
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const text = lastAssistant ? compactLines(extractTextFromContent(lastAssistant.content), 650) : '';
  return normalizeCard({
    title: meta.name,
    outcome: text,
    touched_files: touched,
    confidence: text ? 'low' : 'low',
  }, meta.name, touched);
}

async function generateCardWithMini(meta: SessionMetaRow, messages: MessageRow[], touchedFiles: string[], existingCardText: string): Promise<ReturnType<typeof normalizeCard>> {
  const transcript = messages
    .map((m) => {
      const text = compactLines(extractTextFromContent(m.content), 900);
      if (!isUsefulText(text)) return '';
      return `${m.role}: ${text}`;
    })
    .filter(Boolean)
    .join('\n')
    .slice(-MAX_TEXT_CHARS);

  const prompt = `세션 continuity card를 JSON으로 작성하세요.

목적: 다음 Pi 세션이 사용자의 고민과 작업 맥락을 이어받도록, "사용자가 무엇 때문에 불편/고민했고 AI와 어떻게 협력해 어디까지 풀었는지"를 남기는 것.

중요한 작성 방향:
- 단순 운영 안전수칙, 매 세션 반복되는 git/dirty/push/typecheck/커밋 주의는 기록하지 마세요.
- "푸시는 요청이 없어 하지 않음", "범위 밖 dirty 파일은 건드리지 않음", "테스트 통과" 같은 일상적 절차는 decisions/cautions에 넣지 마세요.
- 대신 사용자의 실제 pain, 막힌 지점, 판단 기준, 협업 방식, 이어갈 큰 맥락을 드러내세요.
- 개발 세션도 파일보다 "왜 이 문제가 중요했는지 / 어떤 방향으로 풀었는지 / 다음 협업에서 무엇을 기억해야 하는지"를 우선하세요.

규칙:
- 한국어로 짧게 작성.
- transcript에 없는 내용을 만들지 말 것.
- 개인정보/연락처/계좌/고객 민감정보 원문을 저장하지 말고 업무 상태로 요약.
- 감정 평가 금지. "고객이 화남" 대신 "산출물 기준이 맞지 않아 수정 필요"처럼 표현.
- 파일/URL/경로는 입력에 있는 것만 사용하되, 핵심 산출물/참조일 때만 artifacts에 넣으세요.
- decisions는 장기적으로 의미 있는 제품/설계/고객 기준만 넣으세요.
- cautions는 이 프로젝트에서 반복 실수하기 쉬운 도메인 특화 주의만 넣으세요. 일반 git/배포 안전수칙 금지.
- 각 배열은 최대 5개.
- next_actions가 없으면 빈 배열.
- JSON 객체만 출력.

JSON schema:
{
  "title": string,
  "outcome": string,
  "pain_points": string[],
  "resolved": string[],
  "steps_taken": string[],
  "next_actions": string[],
  "artifacts": string[],
  "decisions": string[],
  "cautions": string[],
  "touched_files": string[],
  "confidence": "high" | "medium" | "low"
}

세션명: ${meta.name}
프로젝트: ${meta.project_name || meta.project_id || '(no project)'}
현재 turn_count: ${meta.turn_count ?? 0}
실제 수정 파일 후보: ${touchedFiles.join(', ') || '(none)'}

기존 card(있으면 유지/갱신):
${existingCardText || '(none)'}

최근 대화:
${transcript || '(no text)'}
`;

  const raw = await runUtilityTextTask({
    prompt,
    systemPrompt: '당신은 Tower 세션 handoff memory를 만드는 요약기입니다. 도구를 쓰지 말고 JSON 객체만 출력하세요.',
    model: getModelDefaults().ai_reply,
    fallbackText: '',
    timeoutMs: GENERATION_TIMEOUT_MS,
  });
  const parsed = raw ? parseJsonObject(raw) : null;
  if (!parsed) return fallbackFromLastAssistant(meta, messages, touchedFiles);
  return normalizeCard(parsed, meta.name, touchedFiles);
}

async function loadExistingCardText(sessionId: string): Promise<string> {
  const row = await queryOne<any>(
    `SELECT title, outcome, pain_points, resolved, steps_taken, next_actions,
            artifacts, decisions, cautions, touched_files, confidence
       FROM session_memory_cards
      WHERE session_id = $1`,
    [sessionId],
  );
  return row ? JSON.stringify(row) : '';
}

export async function refreshSessionMemoryCardIfNeeded(sessionId: string, opts: { force?: boolean } = {}): Promise<{ refreshed: boolean; reason: string }> {
  if (activeRefreshes.has(sessionId)) return { refreshed: false, reason: 'in-progress' };
  const meta = await loadSessionMeta(sessionId);
  if (!meta) return { refreshed: false, reason: 'session-not-found' };

  const decision = opts.force
    ? { ok: true, reason: 'force', lastAssistant: await loadLastAssistant(sessionId), existing: undefined }
    : await shouldRefresh(meta);
  if (!decision.ok) return { refreshed: false, reason: decision.reason };

  activeRefreshes.add(sessionId);
  try {
    const messages = await loadRecentMessages(sessionId);
    const touchedRows = await loadTouchedFiles(sessionId);
    const touchedFiles = uniqueBasenames(touchedRows.map((r) => r.file_path));
    const existingCardText = await loadExistingCardText(sessionId);
    const card = await generateCardWithMini(meta, messages, touchedFiles, existingCardText);
    const lastAssistant = decision.lastAssistant || await loadLastAssistant(sessionId);
    const model = getModelDefaults().ai_reply;

    await query(
      `INSERT INTO session_memory_cards (
         session_id, user_id, project_id, card_version, revision,
         title, outcome, pain_points, resolved, steps_taken, next_actions,
         artifacts, decisions, cautions, touched_files,
         covered_turn_count, covered_message_id, covered_message_created_at,
         model, confidence, generation_status, last_error, generated_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,1,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,
         $11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19,'success',NULL,NOW(),NOW()
       )
       ON CONFLICT (session_id) DO UPDATE SET
         revision = session_memory_cards.revision + 1,
         title = EXCLUDED.title,
         outcome = EXCLUDED.outcome,
         pain_points = EXCLUDED.pain_points,
         resolved = EXCLUDED.resolved,
         steps_taken = EXCLUDED.steps_taken,
         next_actions = EXCLUDED.next_actions,
         artifacts = EXCLUDED.artifacts,
         decisions = EXCLUDED.decisions,
         cautions = EXCLUDED.cautions,
         touched_files = EXCLUDED.touched_files,
         covered_turn_count = EXCLUDED.covered_turn_count,
         covered_message_id = EXCLUDED.covered_message_id,
         covered_message_created_at = EXCLUDED.covered_message_created_at,
         model = EXCLUDED.model,
         confidence = EXCLUDED.confidence,
         generation_status = 'success',
         last_error = NULL,
         updated_at = NOW()`,
      [
        sessionId,
        meta.user_id,
        meta.project_id,
        CARD_VERSION,
        card.title,
        card.outcome,
        JSON.stringify(card.pain_points),
        JSON.stringify(card.resolved),
        JSON.stringify(card.steps_taken),
        JSON.stringify(card.next_actions),
        JSON.stringify(card.artifacts),
        JSON.stringify(card.decisions),
        JSON.stringify(card.cautions),
        JSON.stringify(card.touched_files),
        meta.turn_count ?? 0,
        lastAssistant?.id ?? null,
        lastAssistant?.created_at ?? null,
        model,
        card.confidence,
      ],
    );
    return { refreshed: true, reason: decision.reason };
  } catch (err) {
    await query(
      `INSERT INTO session_memory_cards (
         session_id, user_id, project_id, title, outcome,
         covered_turn_count, generation_status, last_error, updated_at
       ) VALUES ($1,$2,$3,$4,'',$5,'error',$6,NOW())
       ON CONFLICT (session_id) DO UPDATE SET
         generation_status = 'error',
         last_error = EXCLUDED.last_error,
         updated_at = NOW()`,
      [sessionId, meta.user_id, meta.project_id, meta.name, meta.turn_count ?? 0, (err as Error).message.slice(0, 500)],
    ).catch(() => {});
    return { refreshed: false, reason: `error:${(err as Error).message}` };
  } finally {
    activeRefreshes.delete(sessionId);
  }
}

export function scheduleSessionMemoryCardRefresh(sessionId: string): void {
  setTimeout(() => {
    refreshSessionMemoryCardIfNeeded(sessionId)
      .then((r) => {
        if (r.refreshed) console.log(`[memory-card] refreshed session=${sessionId.slice(0, 8)} reason=${r.reason}`);
      })
      .catch((err) => console.warn(`[memory-card] refresh failed session=${sessionId.slice(0, 8)}: ${(err as Error).message}`));
  }, 0).unref?.();
}

let dueScannerTimer: ReturnType<typeof setInterval> | null = null;
let dueScannerRunning = false;

async function scanDueSessionMemoryCards(): Promise<void> {
  if (dueScannerRunning) return;
  dueScannerRunning = true;
  try {
    const rows = await query<{ session_id: string }>(
      `SELECT smc.session_id
         FROM session_memory_cards smc
         JOIN sessions s ON s.id = smc.session_id
        WHERE smc.generation_status = 'success'
          AND (s.archived IS NULL OR s.archived = 0)
          AND COALESCE(s.turn_count, 0) > smc.covered_turn_count
          AND smc.updated_at < NOW() - interval '60 minutes'
        ORDER BY smc.updated_at ASC
        LIMIT $1`,
      [DUE_SCAN_BATCH_LIMIT],
    );
    for (const row of rows) {
      try {
        const res = await refreshSessionMemoryCardIfNeeded(row.session_id);
        if (res.refreshed) console.log(`[memory-card] due-refreshed session=${row.session_id.slice(0, 8)} reason=${res.reason}`);
      } catch (err) {
        console.warn(`[memory-card] due refresh failed session=${row.session_id.slice(0, 8)}: ${(err as Error).message}`);
      }
    }
  } finally {
    dueScannerRunning = false;
  }
}

export function startSessionMemoryCardDueScanner(): void {
  if (dueScannerTimer) {
    console.warn('[memory-card] Due scanner already running');
    return;
  }
  dueScannerTimer = setInterval(() => {
    scanDueSessionMemoryCards().catch((err) => console.warn('[memory-card] due scanner tick failed:', (err as Error).message));
  }, DUE_SCAN_INTERVAL_MS);
  dueScannerTimer.unref?.();
  console.log(`[memory-card] Due scanner started (interval=${DUE_SCAN_INTERVAL_MS / 1000}s, age=60m, batch=${DUE_SCAN_BATCH_LIMIT})`);
}

export function stopSessionMemoryCardDueScanner(): void {
  if (dueScannerTimer) {
    clearInterval(dueScannerTimer);
    dueScannerTimer = null;
    console.log('[memory-card] Due scanner stopped');
  }
}

export const __sessionMemoryCardTest = { asStringArray, uniqueBasenames, parseJsonObject, dropRoutineOperational, scanDueSessionMemoryCards };

export async function getMemoryCardsForContext(opts: {
  userId: number;
  projectId?: string | null;
  sessionId: string;
  limit?: number;
}): Promise<SessionMemoryCard[]> {
  const limit = opts.limit ?? 5;
  const projectCondition = opts.projectId ? 'project_id = $3' : 'project_id IS NULL';
  const params: any[] = opts.projectId
    ? [opts.userId, opts.sessionId, opts.projectId, limit]
    : [opts.userId, opts.sessionId, limit];
  const limitParam = opts.projectId ? '$4' : '$3';

  return query<SessionMemoryCard>(
    `SELECT *, COALESCE(covered_message_created_at, updated_at)::text AS memory_date,
            (
              CASE WHEN COALESCE(covered_message_created_at, updated_at) > now() - interval '1 day' THEN 40
                   WHEN COALESCE(covered_message_created_at, updated_at) > now() - interval '7 days' THEN 25
                   WHEN COALESCE(covered_message_created_at, updated_at) > now() - interval '30 days' THEN 10
                   ELSE 0 END
              + CASE WHEN jsonb_array_length(next_actions) > 0 THEN 30 ELSE 0 END
              + CASE WHEN jsonb_array_length(pain_points) > 0 THEN 20 ELSE 0 END
              + CASE WHEN jsonb_array_length(resolved) > 0 THEN 15 ELSE 0 END
              + CASE WHEN jsonb_array_length(artifacts) > 0 THEN 10 ELSE 0 END
              + CASE WHEN jsonb_array_length(decisions) > 0 THEN 5 ELSE 0 END
            ) AS score
       FROM session_memory_cards
      WHERE user_id = $1
        AND session_id <> $2
        AND ${projectCondition}
        AND generation_status = 'success'
      ORDER BY score DESC, COALESCE(covered_message_created_at, updated_at) DESC
      LIMIT ${limitParam}`,
    params,
  );
}
