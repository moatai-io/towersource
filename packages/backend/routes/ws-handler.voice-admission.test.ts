import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const mocks = vi.hoisted(() => ({
  getEngine: vi.fn(), getSession: vi.fn(), timing: vi.fn(), save: vi.fn(), steer: vi.fn(), run: vi.fn(), running: vi.fn(), sessionAccess: vi.fn(),
}));
vi.mock('../services/pm/project-access.js', async importOriginal => ({
  ...await importOriginal<typeof import('../services/pm/project-access.js')>(),
  canSendSessionMessage: mocks.sessionAccess,
}));
vi.mock('../engines/index.js', () => ({ getEngine: mocks.getEngine, getTotalActiveCount: () => 0, getAllRunningSessionIds: () => [] }));
vi.mock('../services/session/session-manager.js', () => ({
  getSession: mocks.getSession, claimEngineSessionId: vi.fn(), getEngineSessionId: vi.fn(),
  recordEngineSwitch: vi.fn(), updateSession: vi.fn(), setLastAutoResumeAt: vi.fn(),
}));
vi.mock('../services/agent-turn/turn-supervisor.js', () => ({
  getActiveAgentTurnTiming: mocks.timing, setAgentTurnWaitingUser: vi.fn(),
  rejectAgentTurnStopRequest: vi.fn(), requestAgentTurnStop: vi.fn(), settleAgentTurnStop: vi.fn(),
}));
vi.mock('../services/message-store.js', () => ({
  saveMessage: mocks.save, updateMessageContent: vi.fn(), attachToolResultInDb: vi.fn(), updateMessageMetrics: vi.fn(),
  markCompactBoundary: vi.fn(), getMessages: vi.fn(async () => []), touchMessages: vi.fn(), deleteMessage: vi.fn(),
  findRecoverableAgentTurnForSession: vi.fn(), markAgentTurnCheckpoint: vi.fn(),
}));
vi.mock('../services/ai/claude-sdk.js', () => ({ getSession: vi.fn(), cleanupSession: vi.fn() }));
vi.mock('../db/pg-repo.js', () => ({ query: vi.fn(async () => []), queryOne: vi.fn(async () => undefined), execute: vi.fn() }));
vi.mock('../db/pg.js', () => ({ isPgEnabled: () => true }));
import { handleChat } from './ws-handler.js';
function request(sessionId = randomUUID()) {
  const send = vi.fn();
  const client = { id: randomUUID(), sessionId, userId: 7, userRole: 'member', username: 'test',
    ws: { readyState: 1, send }, activeQueryEpoch: 0, joinedRooms: new Set<string>() };
  const data = { sessionId, messageId: randomUUID(), message: '다른 turn에 삽입하면 안 됩니다.', headless: true, voiceMode: true };
  return { client, data, send };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionAccess.mockResolvedValue({ allowed: true });
  mocks.getSession.mockResolvedValue({ engine: 'pi', modelUsed: 'litellm-responses/smartest' });
  mocks.getEngine.mockResolvedValue({ isRunning: mocks.running, steer: mocks.steer, run: mocks.run });
  mocks.running.mockReturnValue(true);
  mocks.timing.mockResolvedValue(null);
});
describe('actual handleChat locked voice admission (mock DB and engine)', () => {
  it('rejects conversation control before looking up execution state', async () => {
    mocks.sessionAccess.mockResolvedValue({ allowed: false, message: 'owner required' });
    const { client, data, send } = request();
    await handleChat(client as any, data);
    expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({ errorCode: 'ACCESS_DENIED' });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('rejects a normal active engine before persisting, steering or enqueueing the voice input', async () => {
    const { client, data, send } = request();
    await handleChat(client as any, data);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({ type: 'error', errorCode: 'VOICE_BUSY', sessionId: data.sessionId });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.steer).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it.each(['running', 'waiting_retry', 'stop_requested'])('rejects durable %s even before the engine starts', async (state) => {
    mocks.running.mockReturnValue(false);
    mocks.timing.mockResolvedValue({ rootTurnId: 'normal-root', state });
    const { client, data, send } = request();
    await handleChat(client as any, data);
    expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({ errorCode: state === 'waiting_retry' ? 'VOICE_RECOVERY_REQUIRED' : 'VOICE_BUSY' });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.steer).not.toHaveBeenCalled();
  });
  it('serializes admission and releases the lock on BUSY without poisoning input dedupe', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    mocks.getSession.mockImplementationOnce(async () => { await blocked; return { engine: 'pi' }; });
    const first = request();
    const second = request(first.data.sessionId);
    const a = handleChat(first.client as any, first.data);
    const b = handleChat(second.client as any, second.data);
    await vi.waitFor(() => expect(mocks.getSession).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([a, b]);
    // Retrying the identical transport input is still BUSY, not duplicate_user_message_dropped.
    await handleChat(second.client as any, second.data);
    expect(mocks.getSession).toHaveBeenCalledTimes(3);
    expect(second.send.mock.calls.map(([raw]) => JSON.parse(raw).errorCode)).toEqual(['VOICE_BUSY', 'VOICE_BUSY']);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.steer).not.toHaveBeenCalled();
  });
  it('rechecks engine state after the async durable lookup completes', async () => {
    mocks.running.mockReturnValue(false);
    mocks.timing.mockImplementationOnce(async () => { mocks.running.mockReturnValue(true); return null; });
    const { client, data, send } = request();
    await handleChat(client as any, data);
    expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({ errorCode: 'VOICE_BUSY' });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.steer).not.toHaveBeenCalled();
  });
});
