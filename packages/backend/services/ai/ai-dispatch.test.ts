import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseAiMention,
  getEffectiveAiPrompt,
  checkRateLimit,
  recordAiCall,
  resetRateLimits,
  checkConcurrentLimit,
  registerRoomTask,
  unregisterRoomTask,
  resetConcurrentTasks,
  checkAiCallPermission,
  getRoomTaskPermissionMode,
  DEFAULT_RATE_LIMITS,
  ROOM_CONCURRENT_LIMIT,
  type RateLimitConfig,
  type TowerRole,
  type RoomRole,
} from './ai-dispatch';

// ── @ai Mention Parsing ──────────────────────────────────────────

describe('parseAiMention', () => {
  it('detects @ai at start of message', () => {
    const result = parseAiMention('@ai 삼성전자 분석해줘');
    expect(result.found).toBe(true);
    expect(result.prompt).toBe('삼성전자 분석해줘');
  });

  it('detects @ai in middle of message', () => {
    const result = parseAiMention('hey @ai can you help');
    expect(result.found).toBe(true);
    expect(result.prompt).toBe('can you help');
  });

  it('is case-insensitive', () => {
    expect(parseAiMention('@AI do something').found).toBe(true);
    expect(parseAiMention('@Ai mixed case').found).toBe(true);
    expect(parseAiMention('@aI weird case').found).toBe(true);
  });

  it('returns empty prompt when @ai has no following text', () => {
    const result = parseAiMention('@ai');
    expect(result.found).toBe(true);
    expect(result.prompt).toBe('');
  });

  it('returns empty prompt when @ai is followed only by whitespace', () => {
    const result = parseAiMention('@ai   ');
    expect(result.found).toBe(true);
    expect(result.prompt).toBe('');
  });

  it('does NOT match email addresses', () => {
    expect(parseAiMention('email@ai.com').found).toBe(false);
    expect(parseAiMention('user@ai').found).toBe(false);
  });

  it('does NOT match when @ai is part of another word', () => {
    expect(parseAiMention('check this@ai').found).toBe(false);
  });

  it('matches @ai after newline', () => {
    const result = parseAiMention('line one\n@ai do this');
    expect(result.found).toBe(true);
    expect(result.prompt).toBe('do this');
  });

  it('matches @ai after tab', () => {
    const result = parseAiMention('\t@ai tabbed');
    expect(result.found).toBe(true);
    expect(result.prompt).toBe('tabbed');
  });

  it('only extracts text after the FIRST @ai mention', () => {
    const result = parseAiMention('@ai first @ai second');
    expect(result.found).toBe(true);
    expect(result.prompt).toBe('first @ai second');
  });

  it('handles Korean text correctly', () => {
    const result = parseAiMention('@ai 이번 달 ETF 리밸런싱 대상 고객 뽑아줘');
    expect(result.found).toBe(true);
    expect(result.prompt).toBe('이번 달 ETF 리밸런싱 대상 고객 뽑아줘');
  });

  it('handles multiline prompt', () => {
    const result = parseAiMention('@ai 아래 조건으로 분석해줘\n1. 삼성전자\n2. 3개월');
    expect(result.found).toBe(true);
    expect(result.prompt).toBe('아래 조건으로 분석해줘\n1. 삼성전자\n2. 3개월');
  });

  it('no @ai mention at all', () => {
    expect(parseAiMention('just a normal message').found).toBe(false);
    expect(parseAiMention('').found).toBe(false);
    expect(parseAiMention('@ ai spaced').found).toBe(false);
  });
});

describe('getEffectiveAiPrompt', () => {
  it('keeps explicit prompt text unchanged', () => {
    const mention = parseAiMention('@ai 이어서 정리해줘');
    expect(getEffectiveAiPrompt(mention, { replyTo: 'msg-1' })).toBe('이어서 정리해줘');
  });

  it('treats bare @ai in a channel reply as a request to answer from thread context', () => {
    const mention = parseAiMention('@ai');
    expect(getEffectiveAiPrompt(mention, { replyTo: 'msg-1' })).toBe('이 댓글이 달린 메시지/스레드 맥락에 이어서 답해주세요.');
  });

  it('still requires explicit prompt for bare @ai outside a reply', () => {
    const mention = parseAiMention('@ai');
    expect(getEffectiveAiPrompt(mention)).toBe('');
  });

  it('still requires explicit prompt for bare @task even inside a reply', () => {
    const mention = parseAiMention('@task');
    expect(getEffectiveAiPrompt(mention, { replyTo: 'msg-1' })).toBe('');
  });
});

// ── Rate Limiting ────────────────────────────────────────────────

describe('checkRateLimit', () => {
  beforeEach(() => {
    resetRateLimits();
  });

  const baseTime = 1700000000000;

  it('allows first call', () => {
    const result = checkRateLimit(1, 'r1', DEFAULT_RATE_LIMITS, baseTime);
    expect(result.allowed).toBe(true);
  });

  it('blocks user after exceeding per-user limit', () => {
    const config: RateLimitConfig = { userPerMinute: 3, roomPerMinute: 100, globalPerMinute: 100 };

    // Record 3 calls
    for (let i = 0; i < 3; i++) {
      recordAiCall(1, 'r1', baseTime + i * 1000);
    }

    // 4th should be blocked
    const result = checkRateLimit(1, 'r1', config, baseTime + 3000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('user_limit');
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('blocks room after exceeding per-room limit', () => {
    const config: RateLimitConfig = { userPerMinute: 100, roomPerMinute: 3, globalPerMinute: 100 };

    // 3 different users in same room
    recordAiCall(1, 'r1', baseTime);
    recordAiCall(2, 'r1', baseTime + 1000);
    recordAiCall(3, 'r1', baseTime + 2000);

    // 4th call in same room
    const result = checkRateLimit(4, 'r1', config, baseTime + 3000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('room_limit');
  });

  it('blocks globally after exceeding global limit', () => {
    const config: RateLimitConfig = { userPerMinute: 100, roomPerMinute: 100, globalPerMinute: 3 };

    // 3 calls across different users and rooms
    recordAiCall(1, 'r1', baseTime);
    recordAiCall(2, 'r2', baseTime + 1000);
    recordAiCall(3, 'r3', baseTime + 2000);

    const result = checkRateLimit(4, 'r4', config, baseTime + 3000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('global_limit');
  });

  it('allows calls after window expires', () => {
    const config: RateLimitConfig = { userPerMinute: 2, roomPerMinute: 100, globalPerMinute: 100 };

    recordAiCall(1, 'r1', baseTime);
    recordAiCall(1, 'r1', baseTime + 1000);

    // Blocked within window
    expect(checkRateLimit(1, 'r1', config, baseTime + 2000).allowed).toBe(false);

    // Allowed after 60s window
    expect(checkRateLimit(1, 'r1', config, baseTime + 61000).allowed).toBe(true);
  });

  it('user limit is cross-room', () => {
    const config: RateLimitConfig = { userPerMinute: 2, roomPerMinute: 100, globalPerMinute: 100 };

    // Same user, different rooms
    recordAiCall(1, 'r1', baseTime);
    recordAiCall(1, 'r2', baseTime + 1000);

    // Should be blocked (user limit is across all rooms)
    const result = checkRateLimit(1, 'r3', config, baseTime + 2000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('user_limit');
  });

  it('different users have independent limits', () => {
    const config: RateLimitConfig = { userPerMinute: 2, roomPerMinute: 100, globalPerMinute: 100 };

    recordAiCall(1, 'r1', baseTime);
    recordAiCall(1, 'r1', baseTime + 1000);

    // User 1 is blocked
    expect(checkRateLimit(1, 'r1', config, baseTime + 2000).allowed).toBe(false);
    // User 2 is fine
    expect(checkRateLimit(2, 'r1', config, baseTime + 2000).allowed).toBe(true);
  });

  it('retryAfterMs indicates when the next slot opens', () => {
    const config: RateLimitConfig = { userPerMinute: 1, roomPerMinute: 100, globalPerMinute: 100 };

    recordAiCall(1, 'r1', baseTime);

    const result = checkRateLimit(1, 'r1', config, baseTime + 30000);
    expect(result.allowed).toBe(false);
    // Oldest call was at baseTime, window is 60s, so retry after ~30s
    expect(result.retryAfterMs).toBeGreaterThan(29000);
    expect(result.retryAfterMs).toBeLessThanOrEqual(30000);
  });
});

// ── Concurrent Task Limiting ──────────────────────────────────────

describe('checkConcurrentLimit', () => {
  beforeEach(() => {
    resetConcurrentTasks();
  });

  it('allows first task in a room', () => {
    const result = checkConcurrentLimit('r1');
    expect(result.allowed).toBe(true);
    expect(result.runningCount).toBe(0);
    expect(result.limit).toBe(ROOM_CONCURRENT_LIMIT);
  });

  it('allows up to limit tasks', () => {
    registerRoomTask('r1', 't1');
    registerRoomTask('r1', 't2');

    const result = checkConcurrentLimit('r1');
    expect(result.allowed).toBe(true);
    expect(result.runningCount).toBe(2);
  });

  it('blocks at limit', () => {
    registerRoomTask('r1', 't1');
    registerRoomTask('r1', 't2');
    registerRoomTask('r1', 't3');

    const result = checkConcurrentLimit('r1');
    expect(result.allowed).toBe(false);
    expect(result.runningCount).toBe(3);
  });

  it('allows again after task completes', () => {
    registerRoomTask('r1', 't1');
    registerRoomTask('r1', 't2');
    registerRoomTask('r1', 't3');

    expect(checkConcurrentLimit('r1').allowed).toBe(false);

    unregisterRoomTask('r1', 't2');

    expect(checkConcurrentLimit('r1').allowed).toBe(true);
    expect(checkConcurrentLimit('r1').runningCount).toBe(2);
  });

  it('rooms are independent', () => {
    registerRoomTask('r1', 't1');
    registerRoomTask('r1', 't2');
    registerRoomTask('r1', 't3');

    // r1 is full, r2 is empty
    expect(checkConcurrentLimit('r1').allowed).toBe(false);
    expect(checkConcurrentLimit('r2').allowed).toBe(true);
  });

  it('unregistering from empty room is safe', () => {
    unregisterRoomTask('nonexistent', 't1');
    // should not throw
    expect(checkConcurrentLimit('nonexistent').runningCount).toBe(0);
  });

  it('supports custom limit', () => {
    registerRoomTask('r1', 't1');

    expect(checkConcurrentLimit('r1', 1).allowed).toBe(false);
    expect(checkConcurrentLimit('r1', 2).allowed).toBe(true);
  });
});

// ── Permission Check ──────────────────────────────────────────────

describe('checkAiCallPermission', () => {
  const roomRoles: RoomRole[] = ['owner', 'admin', 'member', 'readonly'];

  it('allows admin + owner', () => {
    expect(checkAiCallPermission('admin', 'owner').allowed).toBe(true);
  });

  it('allows member + member', () => {
    expect(checkAiCallPermission('member', 'member').allowed).toBe(true);
  });

  it('blocks viewer regardless of room role', () => {
    for (const rr of roomRoles) {
      const result = checkAiCallPermission('viewer', rr);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('viewer');
    }
  });

  it('blocks readonly regardless of tower role', () => {
    for (const tr of ['admin', 'operator', 'member'] as TowerRole[]) {
      const result = checkAiCallPermission(tr, 'readonly');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('읽기 전용');
    }
  });

  it('allows all non-viewer tower roles with non-readonly room roles', () => {
    for (const tr of ['admin', 'operator', 'member'] as TowerRole[]) {
      for (const rr of ['owner', 'admin', 'member'] as RoomRole[]) {
        expect(checkAiCallPermission(tr, rr).allowed).toBe(true);
      }
    }
  });
});

// ── Room Task Permission Mode ─────────────────────────────────────
// 2026-05-04 (decisions/2026-05-04-five-role-model.md, section D):
//   viewer 만 plan, 그 외 모두 bypassPermissions.
//   채널 협업 흐름을 우선해서 confirm 게이트 제거. damage-control deny 패턴이 안전망.

describe('getRoomTaskPermissionMode', () => {
  it('admin gets bypassPermissions in rooms', () => {
    expect(getRoomTaskPermissionMode('admin')).toBe('bypassPermissions');
  });

  it('operator gets bypassPermissions in rooms', () => {
    expect(getRoomTaskPermissionMode('operator')).toBe('bypassPermissions');
  });

  it('member gets bypassPermissions in rooms', () => {
    expect(getRoomTaskPermissionMode('member')).toBe('bypassPermissions');
  });

  it('guest gets bypassPermissions in rooms', () => {
    expect(getRoomTaskPermissionMode('guest' as any)).toBe('bypassPermissions');
  });

  it('puts viewer in plan mode', () => {
    expect(getRoomTaskPermissionMode('viewer')).toBe('plan');
  });
});
