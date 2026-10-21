import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), cancel: vi.fn(), close: vi.fn(), verify: vi.fn(), query: vi.fn(), access: vi.fn() }));
vi.mock('./tower-session-turn-gateway.js', () => ({
  runTowerVoiceTurn: mocks.run, requestVoiceTurnCancellation: mocks.cancel, closeTowerVoiceSession: mocks.close,
  VoiceTurnError: class extends Error { constructor(public code: string, message: string, public status = 409) { super(message); } },
}));
vi.mock('./voice-turn-token.js', () => ({ verifyVoiceTurnToken: mocks.verify, createVoiceTurnToken: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ queryOne: mocks.query }));
vi.mock('../auth/auth.js', () => ({ authMiddleware: vi.fn() }));
vi.mock('../pm/project-access.js', () => ({ canAccessSession: mocks.access }));
vi.mock('../session/session-manager.js', () => ({ getSession: vi.fn() }));
import { createVoiceRouter } from './voice-router.js';
import { VoiceSessionManager } from './voice-session-manager.js';
import { VoiceTurnError } from './tower-session-turn-gateway.js';
const turnId = '11111111-1111-4111-8111-111111111111';
const token = 'test-only-capability-token-padding-value';
let manager: VoiceSessionManager;
let claims: { sessionId: string; voiceSessionId: string; userId: number; expiresAt: number };
beforeEach(() => {
  vi.resetAllMocks();
  manager = new VoiceSessionManager();
  const voice = manager.start('tower-session', 7);
  claims = { sessionId: 'tower-session', voiceSessionId: voice.id, userId: 7, expiresAt: Date.parse(voice.expiresAt) };
  mocks.verify.mockImplementation(() => claims);
  mocks.query.mockResolvedValue({ role: 'member' });
  mocks.access.mockResolvedValue({ allowed: true });
  mocks.run.mockResolvedValue('답변');
  mocks.cancel.mockResolvedValue(true);
});
async function call(operation: 'turn' | 'cancel', body: unknown) {
  const router = createVoiceRouter({ enabled: true, manager });
  const route = (router as any).stack.find((layer: any) => layer.route?.path === `/voice/internal/${operation}`);
  const res = { statusCode: 200, body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; },
  };
  await route.route.stack[0].handle({ body }, res);
  return res;
}
describe('voice internal HTTP handlers (mock authority and no network)', () => {
  it('passes capability owner and exact identity; echoes response identity', async () => {
    const res = await call('turn', { token, turnId, revision: 3, transcript: ' 질문 ' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ assistantText: '답변', turnId, revision: 3 });
    expect(mocks.run).toHaveBeenCalledWith({ ...claims, turnId, revision: 3, transcript: '질문' }, undefined);
    expect(mocks.access).toHaveBeenCalledWith('tower-session', 7, 'member');
  });
  it('sends cancellation to the server gateway rather than a worker-local engine', async () => {
    const res = await call('cancel', { token, turnId, revision: 3 });
    expect(res.body).toEqual({ accepted: true, turnId, revision: 3 });
    const { expiresAt: _, ...identity } = claims;
    expect(mocks.cancel).toHaveBeenCalledWith({ ...identity, turnId, revision: 3 });
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it.each([
    { token, transcript: '질문' },
    { token, turnId: 'bad-id', revision: 1, transcript: '질문' },
    { token, turnId, revision: 0, transcript: '질문' },
    { token, turnId, revision: 1.5, transcript: '질문' },
    { token, turnId, revision: '1', transcript: '질문' },
    { token, turnId, revision: 1, transcript: '질문', userId: 8 },
  ])('rejects invalid/mutable transport identity: %j', async (body) => {
    expect((await call('turn', body)).statusCode).toBe(400);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('requires the same strict identity on cancellation', async () => {
    expect((await call('cancel', { token, turnId })).statusCode).toBe(400);
    expect((await call('cancel', { token, turnId, revision: -1 })).statusCode).toBe(400);
    expect((await call('cancel', { token, turnId, revision: 1, sessionId: 'other' })).statusCode).toBe(400);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it.each(['turn', 'cancel'] as const)('rejects expired capability on %s', async (operation) => {
    mocks.verify.mockReturnValue(null);
    const body = { token, turnId, revision: 1, ...(operation === 'turn' ? { transcript: '질문' } : {}) };
    expect((await call(operation, body)).statusCode).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('rejects descriptor owner mismatch and stopped voice sessions', async () => {
    claims.userId = 8;
    expect((await call('cancel', { token, turnId, revision: 1 })).statusCode).toBe(410);
    claims.userId = 7;
    manager.stop(claims.voiceSessionId, 7);
    expect((await call('cancel', { token, turnId, revision: 1 })).statusCode).toBe(410);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('honors current ACL revocation rather than relying only on a valid old token', async () => {
    mocks.access.mockResolvedValue({ allowed: false, status: 403, message: 'Access revoked' });
    expect((await call('turn', { token, turnId, revision: 1, transcript: '질문' })).statusCode).toBe(403);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it.each(['VOICE_BUSY', 'VOICE_CANCELLED'])('returns 409 %s, never a spoken answer string', async (code) => {
    mocks.run.mockRejectedValue(new VoiceTurnError(code, 'not an answer'));
    const res = await call('turn', { token, turnId, revision: 1, transcript: '질문' });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ code, error: 'not an answer' });
    expect(res.body).not.toHaveProperty('assistantText');
  });
});


describe('voice stop route', () => {
  async function stop(userId = 7) {
    const router = createVoiceRouter({ enabled: true, manager });
    const route = (router as any).stack.find((layer: any) => layer.route?.path === '/sessions/:sessionId/voice/stop');
    const res = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json: vi.fn(), send: vi.fn() };
    await route.route.stack[0].handle({ body: { voiceSessionId: claims.voiceSessionId }, params: { sessionId: claims.sessionId }, user: { userId, role: 'member' } }, res);
    return res;
  }
  it('calls exact owner close before deleting the descriptor', async () => {
    mocks.close.mockImplementation(async (owner) => {
      expect(owner).toEqual({ voiceSessionId: claims.voiceSessionId, sessionId: claims.sessionId, userId: 7 });
      expect(manager.get(claims.voiceSessionId)).not.toBeNull();
      return true;
    });
    expect((await stop()).statusCode).toBe(204);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(manager.get(claims.voiceSessionId)).toBeNull();
  });
  it('does not close another user voice even with Session access', async () => {
    expect((await stop(8)).statusCode).toBe(404);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(manager.get(claims.voiceSessionId)).not.toBeNull();
  });
  it('rechecks descriptor after ACL await to block stop/admission races', async () => {
    mocks.access.mockImplementation(async () => { manager.stop(claims.voiceSessionId, 7); return { allowed: true }; });
    expect((await call('turn', { token, turnId, revision: 1, transcript: '질문' })).statusCode).toBe(410);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});


describe('NDJSON content negotiation', () => {
  async function stream(body: unknown) {
    const router = createVoiceRouter({ enabled: true, manager });
    const route = (router as any).stack.find((layer: any) => layer.route?.path === '/voice/internal/turn');
    const lines: string[] = [];
    const res = { statusCode: 200, status(code: number) { this.statusCode = code; return this; },
      json: vi.fn(), once: vi.fn(), off: vi.fn(), end: vi.fn(), setHeader: vi.fn(), flushHeaders: vi.fn(),
      write: vi.fn((line: string) => { lines.push(line); return true; }), destroyed: false, writableLength: 0,
    };
    await route.route.stack[0].handle({ body, headers: { accept: 'application/x-ndjson' } }, res);
    return { res, lines: lines.map((line) => JSON.parse(line)) };
  }
  it('writes correlated deltas and done as NDJSON without a final JSON wrapper', async () => {
    mocks.run.mockImplementation(async (_input, emit) => {
      emit({ type: 'answer_delta', turnId, revision: 1, seq: 1, text: '답변.', channel: 'final_answer', elapsedMs: 10 });
      emit({ type: 'done', turnId, revision: 1, seq: 2, assistantText: '답변.', firstTextMs: 10, totalMs: 50 });
      return '답변.';
    });
    const { res, lines } = await stream({ token, turnId, revision: 1, transcript: '질문' });
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/x-ndjson; charset=utf-8');
    expect(lines.map((e) => e.type)).toEqual(['answer_delta', 'done']);
    expect(res.end).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
  it('preserves HTTP 409 before first output for BUSY retries', async () => {
    mocks.run.mockRejectedValue(new VoiceTurnError('VOICE_BUSY', 'Busy'));
    const { res, lines } = await stream({ token, turnId, revision: 1, transcript: '질문' });
    expect(res.statusCode).toBe(409);
    expect(res.json).toHaveBeenCalledWith({ code: 'VOICE_BUSY', error: 'Busy' });
    expect(lines).toEqual([]);
    expect(res.flushHeaders).not.toHaveBeenCalled();
  });
});
