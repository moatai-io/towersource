import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  switchEngine,
  findPendingToolUseIds,
  dropIncompleteTailForPendingToolUseIds,
  type SwitchEngineDeps,
} from './engine-switch.js';
import type { Engine, RehydrateInputMessage } from '../../engines/types.js';
import type { SessionMeta } from '@tower/shared';
import type { StoredMessage } from '../message-store.js';
import type { EngineSwitchRecord } from './session-manager.js';

// ─────────────────────────────────────────────────────────────────────
// Test scaffolding
// ─────────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'sess-1',
    name: 'Test session',
    cwd: '/tmp/test-cwd',
    tags: [],
    favorite: false,
    totalCost: 0,
    totalTokens: 0,
    createdAt: '2026-05-19T00:00:00Z',
    updatedAt: '2026-05-19T00:00:00Z',
    engine: 'claude',
    claudeSessionId: 'claude-aaa-bbb',
    turnCount: 5,
    ...overrides,
  };
}

function storedMsg(
  role: 'user' | 'assistant',
  content: any[],
  id = `m-${Math.random()}`,
  metadata: Record<string, any> | null = null,
): StoredMessage {
  return {
    id,
    session_id: 'sess-1',
    role,
    content: JSON.stringify(content),
    created_at: '2026-05-19T01:00:00.000Z',
    metadata,
  };
}

function makeEngine(opts: {
  isRunning?: boolean;
  rehydrate?: (sessionId: string, msgs: ReadonlyArray<RehydrateInputMessage>, cwd: string) => Promise<string>;
  hasRehydrate?: boolean;
} = {}): Engine {
  const e: any = {
    isRunning: vi.fn(() => !!opts.isRunning),
    abort: vi.fn(),
    dispose: vi.fn(),
    getActiveCount: vi.fn(() => 0),
    getRunningSessionIds: vi.fn(() => []),
    run: vi.fn(),
    quickReply: vi.fn(),
  };
  if (opts.hasRehydrate !== false) {
    e.rehydrateFromMessages = opts.rehydrate ?? vi.fn(async () => '/tmp/.pi/sessions/new.jsonl');
  }
  return e as Engine;
}

interface DepsState {
  session: SessionMeta | null;
  messages: StoredMessage[];
  engines: Record<string, Engine>;
  recordedSwitches: Parameters<SwitchEngineDeps['recordEngineSwitch']>[0][];
  updates: Array<{ id: string; updates: Partial<SessionMeta> }>;
  savedMessages: Array<Parameters<SwitchEngineDeps['saveMessage']>>;
  harnessPins: Array<{ sessionId: string; projectId?: string; targetModel?: string }>;
  nowValue: Date;
}

function makeDeps(state: Partial<DepsState> = {}): { deps: SwitchEngineDeps; state: DepsState } {
  const s: DepsState = {
    // `??` would collapse explicit null into the default — we want null to stay null
    // (the "session missing" guard test depends on this).
    session: 'session' in state ? state.session! : makeSession(),
    messages: state.messages ?? [],
    engines: state.engines ?? {},
    recordedSwitches: [],
    updates: [],
    savedMessages: [],
    harnessPins: [],
    nowValue: state.nowValue ?? new Date('2026-05-19T12:00:00Z'),
  };
  const deps: SwitchEngineDeps = {
    getSession: vi.fn(async () => s.session),
    getMessages: vi.fn(async () => s.messages),
    getEngine: vi.fn(async (name: string) => {
      const e = s.engines[name];
      if (!e) throw new Error(`engine '${name}' disabled`);
      return e;
    }),
    ensurePiHarnessSnapshot: vi.fn(async (input) => {
      s.harnessPins.push(input);
    }),
    recordEngineSwitch: vi.fn(async (input) => {
      s.recordedSwitches.push(input);
      const record: EngineSwitchRecord = {
        id: s.recordedSwitches.length,
        sessionId: input.sessionId,
        fromEngine: input.fromEngine,
        toEngine: input.toEngine,
        atTurn: input.atTurn,
        atMessageId: input.atMessageId ?? null,
        reason: input.reason ?? null,
        fromSessionId: input.fromSessionId ?? null,
        toSessionId: input.toSessionId ?? null,
        switchedAt: s.nowValue.toISOString(),
        switchedBy: input.switchedBy ?? null,
      };
      return record;
    }),
    updateSession: vi.fn(async (id, updates) => {
      s.updates.push({ id, updates });
    }),
    saveMessage: vi.fn(async (sessionId, msg) => {
      s.savedMessages.push([sessionId, msg]);
    }),
    generateMessageId: vi.fn(() => 'sysmsg-1'),
    now: vi.fn(() => s.nowValue),
  };
  return { deps, state: s };
}

// ─────────────────────────────────────────────────────────────────────
// findPendingToolUseIds — algorithm coverage
// ─────────────────────────────────────────────────────────────────────

describe('findPendingToolUseIds', () => {
  it('returns [] when every tool_use has a matching tool_result', () => {
    expect(findPendingToolUseIds([
      { id: 'a-1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'X' }] },
      { id: 'u-1', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
    ])).toEqual([]);
  });

  it('returns the tool_use IDs with no matching tool_result', () => {
    expect(findPendingToolUseIds([
      { id: 'a-1', role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_1', name: 'X' },
        { type: 'tool_use', id: 'tu_2', name: 'Y' },
      ] },
      { id: 'u-1', role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'r1' },
        // tu_2 never closed
      ] },
    ])).toEqual(['tu_2']);
  });

  it('multiple unclosed tool_uses returned in insertion order', () => {
    expect(findPendingToolUseIds([
      { id: 'a-1', role: 'assistant', content: [
        { type: 'tool_use', id: 'first', name: 'X' },
        { type: 'tool_use', id: 'second', name: 'Y' },
        { type: 'tool_use', id: 'third', name: 'Z' },
      ] },
    ])).toEqual(['first', 'second', 'third']);
  });

  it('a later tool_use with the same id (rare, but possible after compaction) is still pending until its own result', () => {
    expect(findPendingToolUseIds([
      { id: 'a-1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'X' }] },
      { id: 'u-1', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
      { id: 'a-2', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'X again' }] },
    ])).toEqual(['tu_1']);
  });

  it('empty input → []', () => {
    expect(findPendingToolUseIds([])).toEqual([]);
  });
});

describe('dropIncompleteTailForPendingToolUseIds', () => {
  it('keeps only the safe prefix before the assistant turn with a dangling tool_use', () => {
    const messages = [
      { id: 'u-1', role: 'user' as const, content: [{ type: 'text', text: 'before' }] },
      { id: 'a-1', role: 'assistant' as const, content: [{ type: 'text', text: 'safe reply' }] },
      { id: 'a-2', role: 'assistant' as const, content: [
        { type: 'text', text: 'I will use a tool' },
        { type: 'tool_use', id: 'tu_pending', name: 'Read', input: {} },
      ] },
      { id: 'u-2', role: 'user' as const, content: [{ type: 'text', text: 'later but unsafe to replay' }] },
    ];

    expect(dropIncompleteTailForPendingToolUseIds(messages, ['tu_pending']).map(m => m.id))
      .toEqual(['u-1', 'a-1']);
  });

  it('returns the original messages when no pending tool_use id is present', () => {
    const messages = [
      { id: 'u-1', role: 'user' as const, content: [{ type: 'text', text: 'hello' }] },
    ];

    expect(dropIncompleteTailForPendingToolUseIds(messages, ['missing'])).toBe(messages);
  });
});

// ─────────────────────────────────────────────────────────────────────
// switchEngine — guards
// ─────────────────────────────────────────────────────────────────────

describe('switchEngine — pre-mutation guards', () => {
  let pi: Engine;
  let claude: Engine;

  beforeEach(() => {
    pi = makeEngine();
    claude = makeEngine();
  });

  it('NOT_FOUND when session missing', async () => {
    const { deps } = makeDeps({ session: null, engines: { pi } });
    const r = await switchEngine({ sessionId: 'nope', toEngine: 'pi' }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });

  it('SAME_ENGINE when target equals current (no-op, no side effects)', async () => {
    const { deps, state } = makeDeps({
      session: makeSession({ engine: 'pi' }),
      engines: { pi },
    });
    const r = await switchEngine({ sessionId: 'sess-1', toEngine: 'pi' }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('SAME_ENGINE');
      if (r.error.code === 'SAME_ENGINE') expect(r.error.engine).toBe('pi');
    }
    // CRITICAL: no DB writes when the switch was a no-op.
    expect(state.updates).toHaveLength(0);
    expect(state.recordedSwitches).toHaveLength(0);
    expect(state.savedMessages).toHaveLength(0);
  });

  it('UNSUPPORTED_TARGET when target engine has no rehydrateFromMessages', async () => {
    const claudeWithoutRehydrate = makeEngine({ hasRehydrate: false });
    const { deps } = makeDeps({
      session: makeSession({ engine: 'pi' }),
      engines: { pi, claude: claudeWithoutRehydrate },
    });
    const r = await switchEngine({ sessionId: 'sess-1', toEngine: 'claude' }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNSUPPORTED_TARGET');
  });

  it('UNSUPPORTED_TARGET when target engine disabled (getEngine throws)', async () => {
    const { deps } = makeDeps({ engines: { claude } /* no pi */ });
    const r = await switchEngine({ sessionId: 'sess-1', toEngine: 'pi' }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('UNSUPPORTED_TARGET');
      expect(r.error.message).toMatch(/disabled/);
    }
  });

  it('UNSUPPORTED_TARGET for an engine with no sessions column mapping (e.g. local)', async () => {
    const local = makeEngine();
    const { deps } = makeDeps({ engines: { claude, local } });
    const r = await switchEngine({ sessionId: 'sess-1', toEngine: 'local' }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('UNSUPPORTED_TARGET');
      expect(r.error.message).toMatch(/No sessions row column mapped/);
    }
  });

  it('RUNNING when source engine reports the session is streaming', async () => {
    const claudeRunning = makeEngine({ isRunning: true });
    const { deps, state } = makeDeps({
      session: makeSession({ engine: 'claude' }),
      engines: { claude: claudeRunning, pi },
    });
    const r = await switchEngine({ sessionId: 'sess-1', toEngine: 'pi' }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RUNNING');
    // Still no side effects past the guards.
    expect(state.updates).toHaveLength(0);
    expect(state.recordedSwitches).toHaveLength(0);
  });

  it('PENDING_TOOL_USE when last assistant turn fired tools without all results back', async () => {
    const messages = [
      storedMsg('assistant', [
        { type: 'tool_use', id: 'tu_pending_1', name: 'Read', input: {} },
        { type: 'tool_use', id: 'tu_pending_2', name: 'Write', input: {} },
      ]),
      // Only one result came back
      storedMsg('user', [{ type: 'tool_result', tool_use_id: 'tu_pending_1', content: 'ok' }]),
    ];
    const { deps, state } = makeDeps({
      session: makeSession({ engine: 'claude' }),
      messages,
      engines: { claude, pi },
    });
    const r = await switchEngine({ sessionId: 'sess-1', toEngine: 'pi' }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('PENDING_TOOL_USE');
      if (r.error.code === 'PENDING_TOOL_USE') {
        expect(r.error.unmatchedToolUseIds).toEqual(['tu_pending_2']);
      }
    }
    expect(state.recordedSwitches).toHaveLength(0);
  });

  it('drops the incomplete tail instead of failing when pendingToolUsePolicy=drop_incomplete_tail', async () => {
    const rehydrate = vi.fn(async () => '/tmp/.pi/sessions/recovered.jsonl');
    const piWithCapture = makeEngine({ rehydrate: rehydrate as unknown as Engine['rehydrateFromMessages'] });
    const messages = [
      storedMsg('user', [{ type: 'text', text: 'safe question' }], 'u-safe'),
      storedMsg('assistant', [{ type: 'text', text: 'safe answer' }], 'a-safe'),
      storedMsg('assistant', [
        { type: 'text', text: 'starting a tool turn' },
        { type: 'tool_use', id: 'tu_stranded', name: 'Read', input: {} },
      ], 'a-stranded'),
    ];
    const { deps, state } = makeDeps({
      session: makeSession({ engine: 'claude' }),
      messages,
      engines: { claude, pi: piWithCapture },
    });

    const r = await switchEngine({
      sessionId: 'sess-1',
      toEngine: 'pi',
      pendingToolUsePolicy: 'drop_incomplete_tail',
    }, deps);

    expect(r.ok).toBe(true);
    const [, callMessages] = rehydrate.mock.calls[0];
    expect(callMessages.map((m: any) => m.id)).toEqual(['u-safe', 'a-safe']);
    expect(state.savedMessages[0][1].metadata?.engineSwitchRecovery).toEqual({
      policy: 'drop_incomplete_tail',
      droppedPendingToolUseIds: ['tu_stranded'],
    });
  });

  it('REHYDRATE_FAILED bubbles up the target engine error without mutating sessions', async () => {
    const piBroken = makeEngine({
      rehydrate: vi.fn(async () => { throw new Error('disk full'); }),
    });
    const { deps, state } = makeDeps({
      session: makeSession({ engine: 'claude' }),
      messages: [storedMsg('user', [{ type: 'text', text: 'hi' }])],
      engines: { claude, pi: piBroken },
    });
    const r = await switchEngine({ sessionId: 'sess-1', toEngine: 'pi' }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('REHYDRATE_FAILED');
      expect(r.error.message).toMatch(/disk full/);
    }
    // Critical: no DB writes after a rehydrate failure.
    expect(state.updates).toHaveLength(0);
    expect(state.recordedSwitches).toHaveLength(0);
    expect(state.savedMessages).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// switchEngine — happy path
// ─────────────────────────────────────────────────────────────────────

describe('switchEngine — successful claude → pi', () => {
  let pi: Engine;
  let claude: Engine;
  let rehydrateMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    rehydrateMock = vi.fn(async () => '/tmp/.pi/sessions/new-pi.jsonl');
    pi = makeEngine({ rehydrate: rehydrateMock as unknown as Engine['rehydrateFromMessages'] });
    claude = makeEngine();
  });

  it('returns ok=true with mapping fields populated', async () => {
    const { deps } = makeDeps({
      session: makeSession({ engine: 'claude', turnCount: 7 }),
      messages: [
        storedMsg('user', [{ type: 'text', text: 'hi' }]),
        storedMsg('assistant', [{ type: 'text', text: 'hello' }]),
      ],
      engines: { claude, pi },
    });

    const r = await switchEngine(
      { sessionId: 'sess-1', toEngine: 'pi', reason: 'user_request', switchedBy: 99 },
      deps,
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fromEngine).toBe('claude');
      expect(r.toEngine).toBe('pi');
      expect(r.atTurn).toBe(7);
      expect(r.targetColumn).toBe('pi_session_file');
      expect(r.newEngineSessionId).toBe('/tmp/.pi/sessions/new-pi.jsonl');
      expect(r.systemMessageId).toBe('sysmsg-1');
      expect(r.history.toEngine).toBe('pi');
    }
  });

  it('pins the Pi Harness before persisting the rehydrated resume file', async () => {
    const { deps, state } = makeDeps({
      session: makeSession({ engine: 'claude', projectId: 'project-1' }),
      messages: [storedMsg('assistant', [{ type: 'text', text: 'ok' }])],
      engines: { claude, pi },
    });

    const r = await switchEngine({
      sessionId: 'sess-1',
      toEngine: 'pi',
      targetModel: 'litellm-responses/smartest',
    }, deps);

    expect(r.ok).toBe(true);
    expect(state.harnessPins).toEqual([{
      sessionId: 'sess-1',
      projectId: 'project-1',
      targetModel: 'litellm-responses/smartest',
    }]);
  });

  it('does not persist piSessionFile when Harness pinning fails after rehydrate', async () => {
    const { deps, state } = makeDeps({
      session: makeSession({ engine: 'claude', projectId: 'project-1' }),
      messages: [storedMsg('assistant', [{ type: 'text', text: 'ok' }])],
      engines: { claude, pi },
    });
    deps.ensurePiHarnessSnapshot = vi.fn(async () => { throw new Error('snapshot unavailable'); });

    const r = await switchEngine({ sessionId: 'sess-1', toEngine: 'pi' }, deps);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('REHYDRATE_FAILED');
      expect(r.error.message).toContain('snapshot unavailable');
    }
    expect(state.updates).toEqual([]);
    expect(state.recordedSwitches).toEqual([]);
    expect(state.savedMessages).toEqual([]);
  });

  it('order of side effects — Harness pin then updateSession(piSessionFile) before recordEngineSwitch', async () => {
    const callOrder: string[] = [];
    const { deps } = makeDeps({
      session: makeSession({ engine: 'claude' }),
      messages: [storedMsg('assistant', [{ type: 'text', text: 'ok' }])],
      engines: { claude, pi },
    });

    // Wrap mocks to record order
    const origPin = deps.ensurePiHarnessSnapshot;
    const origUpdate = deps.updateSession;
    const origRecord = deps.recordEngineSwitch;
    const origSave = deps.saveMessage;
    deps.ensurePiHarnessSnapshot = vi.fn(async (input) => { callOrder.push('ensurePiHarnessSnapshot'); return origPin(input); });
    deps.updateSession = vi.fn(async (id, updates) => { callOrder.push('updateSession'); return origUpdate(id, updates); });
    deps.recordEngineSwitch = vi.fn(async (input) => { callOrder.push('recordEngineSwitch'); return origRecord(input); });
    deps.saveMessage = vi.fn(async (sid, msg) => { callOrder.push('saveMessage'); return origSave(sid, msg); });

    const r = await switchEngine({ sessionId: 'sess-1', toEngine: 'pi' }, deps);
    expect(r.ok).toBe(true);
    // This sequence is what guarantees crash-safety (see engine-switch.ts header).
    expect(callOrder).toEqual(['ensurePiHarnessSnapshot', 'updateSession', 'recordEngineSwitch', 'saveMessage']);
  });

  it('rehydrate receives chronologically ordered RehydrateInputMessage[] derived from DB rows', async () => {
    const { deps } = makeDeps({
      session: makeSession({ engine: 'claude', cwd: '/some/cwd' }),
      messages: [
        storedMsg('user', [{ type: 'text', text: 'q' }], 'u-1'),
        storedMsg('assistant', [{ type: 'text', text: 'a' }], 'a-1'),
      ],
      engines: { claude, pi },
    });
    await switchEngine({ sessionId: 'sess-1', toEngine: 'pi' }, deps);

    expect(rehydrateMock).toHaveBeenCalledTimes(1);
    const [callSessionId, callMessages, callCwd] = rehydrateMock.mock.calls[0];
    expect(callSessionId).toBe('sess-1');
    expect(callCwd).toBe('/some/cwd');
    expect(callMessages).toHaveLength(2);
    expect(callMessages[0]).toMatchObject({ id: 'u-1', role: 'user' });
    expect(callMessages[1]).toMatchObject({ id: 'a-1', role: 'assistant' });
  });

  it('drops messages with corrupt (non-JSON) content rather than aborting the whole switch', async () => {
    const { deps } = makeDeps({
      session: makeSession({ engine: 'claude' }),
      messages: [
        { id: 'u-1', session_id: 's', role: 'user', content: 'NOT VALID JSON {{{', created_at: 'now' } as StoredMessage,
        storedMsg('user', [{ type: 'text', text: 'good' }], 'u-2'),
        storedMsg('assistant', [{ type: 'text', text: 'reply' }], 'a-1'),
      ],
      engines: { claude, pi },
    });

    const r = await switchEngine({ sessionId: 'sess-1', toEngine: 'pi' }, deps);
    expect(r.ok).toBe(true);

    const [, callMessages] = rehydrateMock.mock.calls[0];
    // Corrupt row dropped; clean rows survive.
    expect(callMessages.map((m: any) => m.id)).toEqual(['u-2', 'a-1']);
  });

  it('excludes non-replayable markers (engineSwitch + server-resume) from rehydrate input', async () => {
    const { deps } = makeDeps({
      session: makeSession({ engine: 'claude' }),
      messages: [
        storedMsg('user', [{ type: 'text', text: '진짜 질문' }], 'u-1'),
        // a prior engine-switch marker — must NOT replay as a user turn
        storedMsg('user', [{ type: 'text', text: '🔀 엔진 전환: pi → claude' }], 'marker-1',
          { engineSwitch: { from: 'pi', to: 'claude', atTurn: 3 } }),
        // a server-resume nudge — synthetic, must NOT replay
        storedMsg('user', [{ type: 'text', text: '계속 진행해줘' }], 'resume-1',
          { hidden: 'server-resume' }),
        storedMsg('assistant', [{ type: 'text', text: '실제 답변' }], 'a-1'),
      ],
      engines: { claude, pi },
    });

    const r = await switchEngine({ sessionId: 'sess-1', toEngine: 'pi' }, deps);
    expect(r.ok).toBe(true);

    const [, callMessages] = rehydrateMock.mock.calls[0];
    // Only the real conversation turns reach the new engine.
    expect(callMessages.map((m: any) => m.id)).toEqual(['u-1', 'a-1']);
  });

  it('keeps normal user messages that merely have unrelated metadata', async () => {
    const { deps } = makeDeps({
      session: makeSession({ engine: 'claude' }),
      messages: [
        storedMsg('user', [{ type: 'text', text: '안녕' }], 'u-1', { someOtherFlag: true }),
        storedMsg('assistant', [{ type: 'text', text: '네' }], 'a-1'),
      ],
      engines: { claude, pi },
    });

    const r = await switchEngine({ sessionId: 'sess-1', toEngine: 'pi' }, deps);
    expect(r.ok).toBe(true);

    const [, callMessages] = rehydrateMock.mock.calls[0];
    expect(callMessages.map((m: any) => m.id)).toEqual(['u-1', 'a-1']);
  });

  it('excludes non-replayable markers (engineSwitch / server-resume) from rehydrate input', async () => {
    const withMeta = (
      id: string, role: 'user' | 'assistant', content: any[], metadata: Record<string, any>,
    ): StoredMessage => ({
      id, session_id: 'sess-1', role, content: JSON.stringify(content),
      created_at: '2026-05-19T01:00:00.000Z', metadata,
    });

    const { deps } = makeDeps({
      session: makeSession({ engine: 'claude' }),
      messages: [
        storedMsg('user', [{ type: 'text', text: '진짜 질문' }], 'u-1'),
        storedMsg('assistant', [{ type: 'text', text: '진짜 답변' }], 'a-1'),
        // A prior engine-switch marker — must NOT be replayed as a user turn.
        withMeta('marker-1', 'user', [{ type: 'text', text: '🔀 엔진 전환: pi → claude' }], { engineSwitch: { from: 'pi', to: 'claude' } }),
        // A server-resume nudge — also synthetic.
        withMeta('resume-1', 'user', [{ type: 'text', text: '계속 진행해줘' }], { hidden: 'server-resume' }),
        storedMsg('user', [{ type: 'text', text: '다음 질문' }], 'u-2'),
      ],
      engines: { claude, pi },
    });

    const r = await switchEngine({ sessionId: 'sess-1', toEngine: 'pi' }, deps);
    expect(r.ok).toBe(true);

    const [, callMessages] = rehydrateMock.mock.calls[0];
    // Only real conversation turns reach the new engine.
    expect(callMessages.map((m: any) => m.id)).toEqual(['u-1', 'a-1', 'u-2']);
  });

  it('records audit row with from_session_id from sessions.claudeSessionId and to_session_id from rehydrate output', async () => {
    const { deps, state } = makeDeps({
      session: makeSession({ engine: 'claude', claudeSessionId: 'claude-abc' }),
      messages: [storedMsg('assistant', [{ type: 'text', text: 'ok' }])],
      engines: { claude, pi },
    });

    await switchEngine({ sessionId: 'sess-1', toEngine: 'pi', reason: 'cutover' }, deps);

    expect(state.recordedSwitches).toHaveLength(1);
    expect(state.recordedSwitches[0]).toMatchObject({
      sessionId: 'sess-1',
      fromEngine: 'claude',
      toEngine: 'pi',
      reason: 'cutover',
      fromSessionId: 'claude-abc',
      toSessionId: '/tmp/.pi/sessions/new-pi.jsonl',
    });
  });

  it('inserts a marker message with role=user + metadata.engineSwitch (human-readable text + structured data)', async () => {
    const { deps, state } = makeDeps({
      session: makeSession({ engine: 'claude', turnCount: 3 }),
      messages: [storedMsg('assistant', [{ type: 'text', text: 'ok' }])],
      engines: { claude, pi },
      nowValue: new Date('2026-05-19T15:30:00Z'),
    });

    await switchEngine({ sessionId: 'sess-1', toEngine: 'pi' }, deps);

    expect(state.savedMessages).toHaveLength(1);
    const [sessionIdArg, msg] = state.savedMessages[0];
    expect(sessionIdArg).toBe('sess-1');
    expect(msg.id).toBe('sysmsg-1');
    expect(msg.role).toBe('user');
    expect(msg.username).toBe('[system]');
    expect(msg.content[0].text).toMatch(/claude.*→.*pi/);
    expect(msg.metadata?.engineSwitch).toEqual({
      from: 'claude',
      to: 'pi',
      atTurn: 3,
      at: '2026-05-19T15:30:00.000Z',
    });
  });
});
