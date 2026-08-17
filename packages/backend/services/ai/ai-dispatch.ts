/**
 * AI Dispatch — @ai mention detection, rate limiting, and task creation.
 * Handles chat room @ai mentions → Tower task pipeline.
 */

// ── Types ─────────────────────────────────────────────────────────

export type MentionType = 'ai' | 'task';

export interface AiMention {
  found: boolean;
  prompt: string;        // text after @ai/@task, trimmed
  mentionType: MentionType;
  replyToTaskId?: string;
}

export interface EffectivePromptOptions {
  /** Message id the user is replying to. A bare `@ai` is meaningful in this case. */
  replyTo?: string | null;
}

export interface RateLimitConfig {
  userPerMinute: number;   // per user across all rooms
  roomPerMinute: number;   // per room across all users
  globalPerMinute: number; // server-wide
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: 'user_limit' | 'room_limit' | 'global_limit';
  retryAfterMs?: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  userPerMinute: 5,
  roomPerMinute: 10,
  globalPerMinute: 30,
};

export const ROOM_CONCURRENT_LIMIT = 3;

// ── @ai Mention Parsing ──────────────────────────────────────────

/**
 * Parse a chat message for @ai or @task mentions.
 * Returns the prompt text after the mention, or found=false if no mention.
 *
 * @task is checked first (more specific action).
 * @ai triggers a quick reply (no task creation).
 *
 * Supported patterns:
 *   "@ai 이거 어떻게 생각해?"      → mentionType: 'ai', quick reply
 *   "@task 로그 수집해줘"           → mentionType: 'task', full task
 *   "@AI do something"             → mentionType: 'ai'
 *   "hey @task build this"         → mentionType: 'task'
 *   "email@ai.com"                 → found: false (part of email)
 */
export function parseAiMention(content: string): AiMention {
  // Check @task first (more specific)
  const taskMatch = content.match(/(^|[\s])@task\b/i);
  if (taskMatch) {
    const mentionEnd = (taskMatch.index ?? 0) + taskMatch[0].length;
    const prompt = content.slice(mentionEnd).trim();
    return { found: true, prompt, mentionType: 'task' };
  }

  // Then check @ai
  const aiMatch = content.match(/(^|[\s])@ai\b/i);
  if (aiMatch) {
    const mentionEnd = (aiMatch.index ?? 0) + aiMatch[0].length;
    const prompt = content.slice(mentionEnd).trim();
    return { found: true, prompt, mentionType: 'ai' };
  }

  return { found: false, prompt: '', mentionType: 'ai' };
}

/**
 * Return the prompt that should be sent to the AI for a parsed mention.
 *
 * In a channel reply/comment, users often type only `@ai` because the target
 * message already carries the intent. Treat that as a request to continue from
 * the replied-to thread instead of showing the generic "type a prompt" hint.
 * Bare `@task` still requires an explicit task description.
 */
export function getEffectiveAiPrompt(
  mention: AiMention,
  opts: EffectivePromptOptions = {},
): string {
  const prompt = mention.prompt.trim();
  if (prompt) return prompt;
  if (mention.mentionType === 'ai' && opts.replyTo) {
    return '이 댓글이 달린 메시지/스레드 맥락에 이어서 답해주세요.';
  }
  return '';
}

// ── Rate Limiting (Sliding Window Counter) ────────────────────────

type WindowKey = string; // "user:{id}" | "room:{id}" | "global"

// Internal state — timestamps of recent @ai calls
const callWindows = new Map<WindowKey, number[]>();

/** Visible for testing — reset all rate limit state. */
export function resetRateLimits(): void {
  callWindows.clear();
}

/** Record a call timestamp for a given key. */
function recordCall(key: WindowKey, now: number): void {
  let timestamps = callWindows.get(key);
  if (!timestamps) {
    timestamps = [];
    callWindows.set(key, timestamps);
  }
  timestamps.push(now);
}

/** Count calls within the last windowMs for a given key. */
function countInWindow(key: WindowKey, now: number, windowMs: number): number {
  const timestamps = callWindows.get(key);
  if (!timestamps) return 0;

  // Prune old entries
  const cutoff = now - windowMs;
  const fresh = timestamps.filter(t => t > cutoff);
  callWindows.set(key, fresh);

  return fresh.length;
}

/** Get ms until the oldest entry in the window expires. */
function getRetryAfter(key: WindowKey, now: number, windowMs: number): number {
  const timestamps = callWindows.get(key);
  if (!timestamps || timestamps.length === 0) return 0;
  const oldest = timestamps[0];
  return Math.max(0, (oldest + windowMs) - now);
}

const WINDOW_MS = 60_000; // 1 minute

/**
 * Check if an @ai call is allowed under rate limits.
 * Does NOT record the call — call recordAiCall() after task creation succeeds.
 */
export function checkRateLimit(
  userId: number,
  roomId: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMITS,
  now: number = Date.now(),
): RateLimitResult {
  const userKey: WindowKey = `user:${userId}`;
  const roomKey: WindowKey = `room:${roomId}`;
  const globalKey: WindowKey = 'global';

  // Check user limit
  if (countInWindow(userKey, now, WINDOW_MS) >= config.userPerMinute) {
    return {
      allowed: false,
      reason: 'user_limit',
      retryAfterMs: getRetryAfter(userKey, now, WINDOW_MS),
    };
  }

  // Check room limit
  if (countInWindow(roomKey, now, WINDOW_MS) >= config.roomPerMinute) {
    return {
      allowed: false,
      reason: 'room_limit',
      retryAfterMs: getRetryAfter(roomKey, now, WINDOW_MS),
    };
  }

  // Check global limit
  if (countInWindow(globalKey, now, WINDOW_MS) >= config.globalPerMinute) {
    return {
      allowed: false,
      reason: 'global_limit',
      retryAfterMs: getRetryAfter(globalKey, now, WINDOW_MS),
    };
  }

  return { allowed: true };
}

/** Record a successful @ai call for rate limiting. */
export function recordAiCall(
  userId: number,
  roomId: string,
  now: number = Date.now(),
): void {
  recordCall(`user:${userId}`, now);
  recordCall(`room:${roomId}`, now);
  recordCall('global', now);
}

// ── Concurrent Task Limiting ──────────────────────────────────────

const runningRoomTasks = new Map<string, Set<string>>(); // roomId → taskIds

/** Visible for testing — reset concurrent task state. */
export function resetConcurrentTasks(): void {
  runningRoomTasks.clear();
}

export interface ConcurrentCheckResult {
  allowed: boolean;
  runningCount: number;
  limit: number;
}

/** Check if a room can accept another @ai task. */
export function checkConcurrentLimit(
  roomId: string,
  limit: number = ROOM_CONCURRENT_LIMIT,
): ConcurrentCheckResult {
  const running = runningRoomTasks.get(roomId);
  const count = running?.size ?? 0;
  return {
    allowed: count < limit,
    runningCount: count,
    limit,
  };
}

/** Register a task as running in a room. */
export function registerRoomTask(roomId: string, taskId: string): void {
  let set = runningRoomTasks.get(roomId);
  if (!set) {
    set = new Set();
    runningRoomTasks.set(roomId, set);
  }
  set.add(taskId);
}

/** Unregister a task when it completes/fails. */
export function unregisterRoomTask(roomId: string, taskId: string): void {
  const set = runningRoomTasks.get(roomId);
  if (set) {
    set.delete(taskId);
    if (set.size === 0) runningRoomTasks.delete(roomId);
  }
}

// ── Permission Check ──────────────────────────────────────────────

// Single source of truth for TowerRole lives in damage-control.ts.
// Re-export here for convenience (callers depend on this name from ai-dispatch).
export type { TowerRole } from '../damage-control.js';
import type { TowerRole } from '../damage-control.js';

export type RoomRole = 'owner' | 'admin' | 'member' | 'readonly';

export interface AiCallPermission {
  allowed: boolean;
  reason?: string;
}

/**
 * Check if a user can invoke @ai in a room.
 * Requires Tower role != viewer AND Room role != readonly.
 * (guest 는 member 와 동일하게 @ai 호출 가능 — 2026-05-04 결정)
 */
export function checkAiCallPermission(
  towerRole: TowerRole,
  roomRole: RoomRole,
): AiCallPermission {
  const towerDenied = towerRole === 'viewer';
  const roomDenied = roomRole === 'readonly';

  if (towerDenied) {
    return { allowed: false, reason: 'Tower viewer 역할은 @ai를 호출할 수 없습니다.' };
  }
  if (roomDenied) {
    return { allowed: false, reason: '읽기 전용 멤버는 @ai를 호출할 수 없습니다.' };
  }

  return { allowed: true };
}

/**
 * Determine the execution permission mode for a room @ai task.
 *
 * 2026-05-04 (decisions/2026-05-04-five-role-model.md, section D):
 *   viewer → plan, 그 외(admin/operator/member/guest) → bypassPermissions.
 *   채널은 팀 협업 흐름을 우선해서 confirm 게이트를 제거한다. 안전망은
 *   damage-control 의 deny 패턴에 단일화 (sudo, rm -rf 등은 여전히 차단).
 */
export function getRoomTaskPermissionMode(
  towerRole: TowerRole,
): 'bypassPermissions' | 'acceptEdits' | 'plan' {
  if (towerRole === 'viewer') return 'plan';
  return 'bypassPermissions';
}
