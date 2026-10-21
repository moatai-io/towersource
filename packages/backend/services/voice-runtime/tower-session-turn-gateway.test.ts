import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const mocks = vi.hoisted(() => ({
  fast: vi.fn(), broadcast: vi.fn(), handleChat: vi.fn(), getSession: vi.fn(), queryOne: vi.fn(), timing: vi.fn(),
  currentRoot: vi.fn(), getEngine: vi.fn(), stop: vi.fn(), request: vi.fn(), reject: vi.fn(),
}));
vi.mock('../../routes/ws-handler.js', () => ({ handleChat: mocks.handleChat, broadcastToSession: mocks.broadcast }));
vi.mock('./voice-fast-execution.js', () => ({ tryVoiceFastDirect: mocks.fast }));
vi.mock('../session/session-manager.js', () => ({ getSession: mocks.getSession }));
vi.mock('../../db/pg-repo.js', () => ({ queryOne: mocks.queryOne }));
vi.mock('../agent-turn/turn-supervisor.js', () => ({
  getActiveAgentTurnTiming: mocks.timing, requestAgentTurnStop: mocks.request, rejectAgentTurnStopRequest: mocks.reject,
}));
vi.mock('../agent-turn/current-root-turn.js', () => ({ getCurrentRootTurn: mocks.currentRoot }));
vi.mock('../../engines/index.js', () => ({ getEngine: mocks.getEngine }));
import { closeTowerVoiceSession as close, requestVoiceTurnCancellation as cancel, runTowerVoiceTurn as run } from './tower-session-turn-gateway.js';
function input() {
  return { sessionId: randomUUID(), voiceSessionId: randomUUID(), userId: 7, turnId: randomUUID(), revision: 1, transcript: '질문' };
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSession.mockResolvedValue({ engine: 'pi', modelUsed: 'session-model' });
  mocks.timing.mockResolvedValue(null);
  mocks.handleChat.mockResolvedValue(undefined);
  mocks.getEngine.mockResolvedValue({ requestStopAtBoundary: mocks.stop });
  mocks.stop.mockResolvedValue({ accepted: true });
  mocks.request.mockResolvedValue(true);
  mocks.reject.mockResolvedValue(true);
  mocks.queryOne.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT username')) return { username: 'voice-user', role: 'member' };
    if (sql.startsWith('SELECT state')) return { state: 'completed', terminal_at: 'now', assistant_message_id: 'answer-id' };
    if (sql.startsWith('SELECT content')) return { content: JSON.stringify([{ type: 'text', text: '정확한 응답' }]) };
    return null;
  });
});
describe('voice backend execution boundary (no DB/provider)', () => {
  it('uses messageId=turnId and Session model policy; selects only the terminal-linked answer', async () => {
    const request = input();
    await expect(run(request)).resolves.toBe('정확한 응답');
    const [client, payload] = mocks.handleChat.mock.calls[0];
    expect(client).toMatchObject({ userId: 7, username: 'voice-user', userRole: 'member' });
    expect(payload).toMatchObject({ messageId: request.turnId, voiceMode: true, headless: true });
    expect(payload).not.toHaveProperty('model');
    expect(payload).not.toHaveProperty('effort');
    expect(mocks.queryOne).toHaveBeenCalledWith(expect.stringContaining('root_turn_id = $1 AND session_id = $2'), [request.turnId, request.sessionId]);
    expect(mocks.queryOne).toHaveBeenCalledWith(expect.stringContaining("AND role = 'assistant'"), [request.sessionId, 'answer-id']);
  });
  it('shares in-flight/replayed duplicate results without executing twice', async () => {
    const request = input();
    const gate = deferred();
    mocks.handleChat.mockReturnValue(gate.promise);
    const first = run(request);
    const duplicate = run(request);
    gate.resolve();
    await expect(Promise.all([first, duplicate])).resolves.toEqual(['정확한 응답', '정확한 응답']);
    await expect(run(request)).resolves.toBe('정확한 응답');
    expect(mocks.handleChat).toHaveBeenCalledTimes(1);
    await expect(run({ ...request, transcript: '다른 입력' })).rejects.toMatchObject({ code: 'VOICE_TURN_CONFLICT' });
    await expect(run({ ...request, revision: 2 })).rejects.toMatchObject({ code: 'VOICE_TURN_CONFLICT' });
  });
  it('returns typed BUSY for another local voice turn but allows different Sessions', async () => {
    const request = input();
    const gate = deferred();
    mocks.handleChat.mockReturnValue(gate.promise);
    const first = run(request);
    await expect(run({ ...input(), sessionId: request.sessionId })).rejects.toMatchObject({ code: 'VOICE_BUSY', status: 409 });
    const other = run(input());
    gate.resolve();
    await Promise.all([first, other]);
    expect(mocks.handleChat).toHaveBeenCalledTimes(2);
  });
  it('does not dispatch against an active durable root and permits a BUSY retry', async () => {
    const request = input();
    mocks.timing.mockResolvedValue({ rootTurnId: 'normal-chat', state: 'running' });
    await expect(run(request)).rejects.toMatchObject({ code: 'VOICE_BUSY' });
    expect(mocks.handleChat).not.toHaveBeenCalled();
    mocks.timing.mockResolvedValue(null);
    await expect(run(request)).resolves.toBe('정확한 응답');
  });
  it('tombstones cancel-before-turn and refuses mismatched ownership', async () => {
    const request = input();
    await expect(cancel(request)).resolves.toBe(true);
    await expect(run(request)).rejects.toMatchObject({ code: 'VOICE_CANCELLED', status: 409 });
    for (const changed of [
      { userId: 8 }, { sessionId: randomUUID() }, { voiceSessionId: randomUUID() }, { revision: 2 },
    ]) await expect(cancel({ ...request, ...changed })).resolves.toBe(false);
    expect(mocks.handleChat).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    await expect(cancel(request.sessionId)).resolves.toBe(false);
  });
  it('stops only the exact running root in this server and suppresses a late answer', async () => {
    const request = input();
    const gate = deferred();
    mocks.handleChat.mockReturnValue(gate.promise);
    const running = run(request);
    const rejected = expect(running).rejects.toMatchObject({ code: 'VOICE_CANCELLED' });
    await vi.waitFor(() => expect(mocks.handleChat).toHaveBeenCalledTimes(1));
    mocks.timing.mockResolvedValue({ rootTurnId: request.turnId, state: 'running' });
    mocks.currentRoot.mockReturnValue(request.turnId);
    await expect(cancel(request)).resolves.toBe(true);
    expect(mocks.request).toHaveBeenCalledWith({ rootTurnId: request.turnId, mode: 'safe' });
    expect(mocks.stop).toHaveBeenCalledWith(request.sessionId);
    gate.resolve();
    await rejected;
    await expect(run(request)).rejects.toMatchObject({ code: 'VOICE_CANCELLED' });
    expect(mocks.queryOne.mock.calls.some(([sql]) => sql.startsWith('SELECT content'))).toBe(false);
  });
  it('rechecks process-local ownership after async stop admission so stale cancel never stops newer B', async () => {
    const request = input();
    const gate = deferred();
    mocks.handleChat.mockReturnValue(gate.promise);
    const rejected = expect(run(request)).rejects.toMatchObject({ code: 'VOICE_CANCELLED' });
    await vi.waitFor(() => expect(mocks.handleChat).toHaveBeenCalled());
    mocks.timing.mockResolvedValue({ rootTurnId: request.turnId, state: 'running' });
    mocks.currentRoot.mockReturnValue('newer-normal-chat-B');
    await expect(cancel(request)).resolves.toBe(false);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.reject).toHaveBeenCalledWith(expect.objectContaining({ rootTurnId: request.turnId }));
    gate.resolve();
    await rejected;
  });
  it('rejects cancellation when durable active root belongs to another turn', async () => {
    const request = input();
    const gate = deferred();
    mocks.handleChat.mockReturnValue(gate.promise);
    const rejected = expect(run(request)).rejects.toMatchObject({ code: 'VOICE_CANCELLED' });
    await vi.waitFor(() => expect(mocks.handleChat).toHaveBeenCalled());
    mocks.timing.mockResolvedValue({ rootTurnId: 'other-root', state: 'running' });
    await expect(cancel(request)).resolves.toBe(false);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    gate.resolve();
    await rejected;
  });
  it('catches cancellation during admission without starting the engine', async () => {
    const request = input();
    const gate = deferred<{ engine: string }>();
    mocks.getSession.mockReturnValue(gate.promise);
    const rejected = expect(run(request)).rejects.toMatchObject({ code: 'VOICE_CANCELLED' });
    await expect(cancel(request)).resolves.toBe(true);
    gate.resolve({ engine: 'pi' });
    await rejected;
    expect(mocks.handleChat).not.toHaveBeenCalled();
  });
  it('retries safe cancellation when it arrived before the engine root was bound', async () => {
    const request = input();
    const gate = deferred();
    mocks.handleChat.mockReturnValue(gate.promise);
    const rejected = expect(run(request)).rejects.toMatchObject({ code: 'VOICE_CANCELLED' });
    await vi.waitFor(() => expect(mocks.handleChat).toHaveBeenCalled());
    await expect(cancel(request)).resolves.toBe(false);
    mocks.timing.mockResolvedValue({ rootTurnId: request.turnId, state: 'running' });
    mocks.currentRoot.mockReturnValue(request.turnId);
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledWith(request.sessionId));
    gate.resolve();
    await rejected;
  });
  it.each(['running', 'failed', 'needs_attention', 'waiting_retry'])('never reads commentary for nonterminal state %s', async (state) => {
    const original = mocks.queryOne.getMockImplementation()!;
    mocks.queryOne.mockImplementation(async (sql: string, args: unknown[]) => sql.startsWith('SELECT state')
      ? { state, terminal_at: null, assistant_message_id: 'commentary-id' } : original(sql, args));
    await expect(run(input())).rejects.toMatchObject({ code: 'VOICE_NO_TERMINAL_RESPONSE' });
    expect(mocks.queryOne.mock.calls.some(([sql]) => sql.startsWith('SELECT content'))).toBe(false);
  });
  it('blocks restart/replayed durable root IDs without starting provider work', async () => {
    const original = mocks.queryOne.getMockImplementation()!;
    mocks.queryOne.mockImplementation(async (sql: string, args: unknown[]) => sql.startsWith('SELECT root_turn_id')
      ? { root_turn_id: 'already-used' } : original(sql, args));
    await expect(run(input())).rejects.toMatchObject({ code: 'VOICE_DUPLICATE' });
    expect(mocks.handleChat).not.toHaveBeenCalled();
  });
  it('does not re-execute a failed dispatch on a replay', async () => {
    const request = input();
    mocks.handleChat.mockRejectedValue(new Error('provider failure'));
    await expect(run(request)).rejects.toThrow('provider failure');
    await expect(run(request)).rejects.toThrow('provider failure');
    expect(mocks.handleChat).toHaveBeenCalledTimes(1);
  });
  it('fails closed when handleChat silently steers the request into a racing normal chat', async () => {
    mocks.handleChat.mockImplementation(async (client) => client.ws.send(JSON.stringify({ type: 'user_message_steered' })));
    await expect(run(input())).rejects.toMatchObject({ code: 'VOICE_TURN_NOT_STARTED' });
  });
});


describe('voice close and expiry', () => {
  it('closes only its owned active turn and revokes even a new UUID before descriptor removal', async () => {
    const request = input();
    const gate = deferred();
    mocks.handleChat.mockReturnValue(gate.promise);
    const rejected = expect(run(request)).rejects.toMatchObject({ code: 'VOICE_CANCELLED' });
    await vi.waitFor(() => expect(mocks.handleChat).toHaveBeenCalled());
    await expect(close({ ...request, voiceSessionId: randomUUID() }, Date.now() + 60000)).resolves.toBe(false);
    mocks.timing.mockResolvedValue({ rootTurnId: request.turnId, state: 'running' });
    mocks.currentRoot.mockReturnValue(request.turnId);
    await expect(close(request, Date.now() + 60000)).resolves.toBe(true);
    await expect(run({ ...request, turnId: randomUUID(), revision: 2 })).rejects.toMatchObject({ code: 'VOICE_CANCELLED' });
    expect(mocks.stop).toHaveBeenCalledWith(request.sessionId);
    gate.resolve();
    await rejected;
  });
  it('expires a running turn without another HTTP request and suppresses its late reply', async () => {
    vi.useFakeTimers();
    try {
      const request = { ...input(), expiresAt: Date.now() + 1000 };
      const gate = deferred();
      mocks.handleChat.mockReturnValue(gate.promise);
      const rejected = expect(run(request)).rejects.toMatchObject({ code: 'VOICE_CANCELLED' });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.handleChat).toHaveBeenCalled();
      mocks.timing.mockResolvedValue({ rootTurnId: request.turnId, state: 'running' });
      mocks.currentRoot.mockReturnValue(request.turnId);
      await vi.advanceTimersByTimeAsync(1001);
      expect(mocks.stop).toHaveBeenCalledWith(request.sessionId);
      gate.resolve();
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
    } finally { vi.useRealTimers(); }
  });
  it('rejects already expired input before dispatch', async () => {
    await expect(run({ ...input(), expiresAt: Date.now() - 1 })).rejects.toMatchObject({ code: 'VOICE_CANCELLED' });
    expect(mocks.handleChat).not.toHaveBeenCalled();
  });
  it('maps locked admission BUSY to retryable HTTP semantics without caching rejection', async () => {
    const request = input();
    mocks.handleChat.mockImplementationOnce(async (client) => client.ws.send(JSON.stringify({ type: 'error', errorCode: 'VOICE_BUSY' })));
    await expect(run(request)).rejects.toMatchObject({ code: 'VOICE_BUSY', status: 409 });
    await expect(run(request)).resolves.toBe('정확한 응답');
    expect(mocks.handleChat).toHaveBeenCalledTimes(2);
  });
});


describe('turn-correlated semantic streaming', () => {
  const eventFor = (request: ReturnType<typeof input>, text: string) => ({
    rootTurnId: request.turnId, sessionId: request.sessionId, messageId: 'answer-id', text, channel: 'final_answer',
  });
  it('emits first eligible text before execution completes and replays exact seq without re-execution', async () => {
    const request = input();
    const gate = deferred();
    const events: any[] = [];
    mocks.handleChat.mockImplementation(async (client) => {
      client.onVoiceAnswerSnapshot(eventFor(request, '정확한 '));
      client.onVoiceAnswerSnapshot(eventFor(request, '정확한 ')); // cumulative duplicate
      await gate.promise;
      client.onVoiceAnswerSnapshot(eventFor(request, '정확한 응답'));
    });
    const running = run(request, (event) => events.push(event));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ type: 'answer_delta', seq: 1, text: '정확한', turnId: request.turnId, revision: 1 });
    const replay: any[] = [];
    const duplicate = run(request, (event) => replay.push(event));
    gate.resolve();
    await Promise.all([running, duplicate]);
    expect(events.map((e) => e.type)).toEqual(['answer_delta', 'answer_delta', 'done']);
    expect(replay).toEqual(events);
    expect(events.at(-1)).toMatchObject({ assistantText: '정확한 응답', firstTextMs: expect.any(Number), totalMs: expect.any(Number) });
    expect(mocks.handleChat).toHaveBeenCalledTimes(1);
  });
  it('rejects wrong-root and wrong-channel snapshots; unsupported paths explicitly complete without early text', async () => {
    const request = input();
    const events: any[] = [];
    mocks.handleChat.mockImplementation(async (client) => {
      client.onVoiceAnswerSnapshot({ ...eventFor(request, '틀림'), rootTurnId: 'other-turn' });
      client.onVoiceAnswerSnapshot({ ...eventFor(request, '계획'), channel: 'commentary' });
    });
    await run(request, (event) => events.push(event));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'done', firstTextMs: null });
  });
  it('stops forwarding immediately on cancellation and emits a correlated terminal error', async () => {
    const request = input();
    const gate = deferred();
    const events: any[] = [];
    mocks.handleChat.mockImplementation(async (client) => {
      client.onVoiceAnswerSnapshot(eventFor(request, '정확한 '));
      await gate.promise;
      client.onVoiceAnswerSnapshot(eventFor(request, '정확한 응답'));
    });
    const rejected = expect(run(request, (e) => events.push(e))).rejects.toMatchObject({ code: 'VOICE_CANCELLED' });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await cancel(request);
    gate.resolve();
    await rejected;
    expect(events.map((e) => e.type)).toEqual(['answer_delta', 'error']);
    expect(events[1]).toMatchObject({ turnId: request.turnId, revision: 1, seq: 2, code: 'VOICE_CANCELLED', status: 409 });
  });
  it('does not splice a rewritten snapshot or replay a full conflicting terminal answer', async () => {
    const request = input();
    const events: any[] = [];
    mocks.handleChat.mockImplementation(async (client) => {
      client.onVoiceAnswerSnapshot(eventFor(request, '첫 답변.'));
      client.onVoiceAnswerSnapshot(eventFor(request, '바뀐 답변.'));
    });
    await expect(run(request, (e) => events.push(e))).rejects.toMatchObject({ code: 'VOICE_STREAM_DIVERGED' });
    expect(events.map((e) => e.type)).toEqual(['answer_delta', 'error']);
    expect(events[1].code).toBe('VOICE_STREAM_DIVERGED');
  });
});


describe('voice first-text telemetry', () => {
  it('records 120ms first eligible text before 1000ms terminal completion (synthetic clock, not provider latency)', async () => {
    vi.useFakeTimers();
    try {
      const request = input();
      const events: any[] = [];
      mocks.handleChat.mockImplementation(async (client) => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        client.onVoiceAnswerSnapshot({ rootTurnId: request.turnId, sessionId: request.sessionId,
          messageId: 'answer-id', text: '정확한 응답', channel: 'final_answer' });
        await new Promise((resolve) => setTimeout(resolve, 880));
      });
      const running = run(request, (event) => events.push(event));
      await vi.advanceTimersByTimeAsync(120);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'answer_delta', elapsedMs: 120 });
      await vi.advanceTimersByTimeAsync(880);
      await running;
      expect(events[1]).toMatchObject({ type: 'done', firstTextMs: 120, totalMs: 1000 });
      console.info('voice_stream_fake_clock first_text_ms=120 terminal_ms=1000 early_delivery_ms=880 provider_calls=0');
    } finally { vi.useRealTimers(); }
  });
});


describe('backend latency closure', () => {
  it('correlates server-only milestones to exact turn/revision and never logs input or raw event fields', async () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const request = { ...input(), transcript: 'DO_NOT_LOG_INPUT', revision: 4 };
      mocks.handleChat.mockImplementation(async (client) => {
        client.onVoiceTiming({ rootTurnId: 'wrong-turn', sessionId: request.sessionId, stage: 'engine_enter' });
        client.onVoiceTiming({ rootTurnId: request.turnId, sessionId: request.sessionId, stage: 'engine_model_ready', model: 'litellm-responses/smartest', prompt: request.transcript });
      });
      await run(request);
      const lines = output.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('[voice-latency]'));
      const rows = lines.map((line) => JSON.parse(line.slice(16)));
      expect(rows.every((row) => row.turnId === request.turnId && row.revision === 4)).toBe(true);
      expect(rows.map((row) => row.stage)).toEqual(['gateway_received', 'gateway_authority_ready', 'chat_dispatch', 'engine_model_ready', 'chat_complete', 'gateway_terminal']);
      expect(lines.join('')).not.toContain('DO_NOT_LOG_INPUT');
    } finally { output.mockRestore(); }
  });
});


describe('gateway fast/Tower single execution choice', () => {
  it('serves durable direct once and never invokes handleChat for duplicate/replay', async () => {
    const request = input();
    mocks.fast.mockResolvedValue({ assistantText: '안녕하세요', assistantMessageId: 'direct-answer' });
    const events: any[] = [];
    const first = run(request, (e) => events.push(e)); const duplicate = run(request);
    await expect(Promise.all([first, duplicate])).resolves.toEqual(['안녕하세요', '안녕하세요']);
    await expect(run(request)).resolves.toBe('안녕하세요');
    expect(mocks.fast).toHaveBeenCalledTimes(1); expect(mocks.handleChat).not.toHaveBeenCalled();
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ type: 'done', assistantText: '안녕하세요' });
    expect(mocks.broadcast).toHaveBeenCalledWith(request.sessionId, expect.objectContaining({ type: 'tower_message' }));
  });
  it('delegates to handleChat exactly once without changing transcript, model or effort', async () => {
    const request = input(); mocks.fast.mockResolvedValue(undefined);
    await run(request); await run(request);
    expect(mocks.fast).toHaveBeenCalledTimes(1); expect(mocks.handleChat).toHaveBeenCalledTimes(1);
    expect(mocks.handleChat.mock.calls[0][1]).toMatchObject({ message: request.transcript, messageId: request.turnId });
    expect(mocks.handleChat.mock.calls[0][1]).not.toHaveProperty('model');
  });
  it('aborts exact fast signal on cancellation and never reads late direct result aloud', async () => {
    const request = input(); const gate = deferred<any>(); mocks.fast.mockReturnValue(gate.promise);
    const rejected = expect(run(request)).rejects.toMatchObject({ code: 'VOICE_CANCELLED' });
    await vi.waitFor(() => expect(mocks.fast).toHaveBeenCalled());
    await cancel(request);
    expect(mocks.fast.mock.calls[0][0].signal.aborted).toBe(true);
    gate.resolve({ assistantText: 'late', assistantMessageId: 'late' }); await rejected;
    expect(mocks.broadcast).not.toHaveBeenCalled(); expect(mocks.handleChat).not.toHaveBeenCalled();
  });
});

describe('orphan/recovery root admission', () => {
  it('returns a nonretryable recovery code for waiting_retry instead of another BUSY retry cycle', async () => {
    const request = input();
    mocks.timing.mockResolvedValue({ rootTurnId: 'previous-orphan', state: 'waiting_retry' });
    await expect(run(request)).rejects.toMatchObject({ code: 'VOICE_RECOVERY_REQUIRED', status: 409 });
    await expect(run(request)).rejects.toMatchObject({ code: 'VOICE_RECOVERY_REQUIRED' });
    expect(mocks.handleChat).not.toHaveBeenCalled(); expect(mocks.fast).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.stop).not.toHaveBeenCalled();
  });
});
