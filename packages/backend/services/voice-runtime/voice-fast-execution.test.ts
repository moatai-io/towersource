import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
const m = vi.hoisted(() => ({ session: vi.fn(), active: vi.fn(), engine: vi.fn(), actor: vi.fn(), access: vi.fn(), provider: vi.fn(), commit: vi.fn() }));
vi.mock('../session/session-manager.js', () => ({ getSession: m.session }));
vi.mock('../agent-turn/turn-supervisor.js', () => ({ getActiveAgentTurnTiming: m.active }));
vi.mock('../../engines/index.js', () => ({ getEngine: m.engine }));
vi.mock('../../db/pg-repo.js', () => ({ queryOne: m.actor }));
vi.mock('../pm/project-access.js', () => ({ canAccessSession: m.access }));
vi.mock('./voice-fast-provider.js', () => ({ voiceFastProvider: { decide: m.provider } }));
vi.mock('./voice-fast-store.js', () => ({ commitVoiceFastDirect: m.commit }));
import { tryVoiceFastDirect } from './voice-fast-execution.js';
import { acquireSessionAdmissionLock } from '../agent-turn/session-admission-lock.js';
const input = () => ({ voiceSessionId: 'v', sessionId: 's', userId: 7, turnId: 't', revision: 1, transcript: '안녕하세요', signal: new AbortController().signal });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('TOWER_VOICE_FAST_ENABLED', 'true'); vi.stubEnv('TOWER_VOICE_FAST_MODEL', 'litellm-responses/mini');
  m.session.mockResolvedValue({ engine: 'pi' }); m.active.mockResolvedValue(null); m.engine.mockResolvedValue({ isRunning: () => false });
  m.actor.mockResolvedValue({ username: 'test', role: 'member' }); m.access.mockResolvedValue({ allowed: true });
  m.provider.mockResolvedValue({ kind: 'direct', answer: '안녕하세요.' }); m.commit.mockResolvedValue({ assistantMessageId: 'answer' });
});
afterEach(() => vi.unstubAllEnvs());
describe('fast execution with real shared admission mutex', () => {
  it('commits one direct pair and returns only after commit', async () => {
    await expect(tryVoiceFastDirect(input())).resolves.toEqual({ assistantText: '안녕하세요.', assistantMessageId: 'answer' });
    expect(m.commit).toHaveBeenCalledTimes(1); expect(m.access).toHaveBeenCalledTimes(2);
  });
  it('delegate/disabled/model missing writes nothing', async () => {
    m.provider.mockResolvedValue({ kind: 'delegate' }); await expect(tryVoiceFastDirect(input())).resolves.toBeUndefined();
    vi.stubEnv('TOWER_VOICE_FAST_ENABLED', 'false'); await expect(tryVoiceFastDirect(input())).resolves.toBeUndefined();
    vi.stubEnv('TOWER_VOICE_FAST_ENABLED', 'true'); vi.stubEnv('TOWER_VOICE_FAST_MODEL', ''); await expect(tryVoiceFastDirect(input())).resolves.toBeUndefined();
    expect(m.commit).not.toHaveBeenCalled(); expect(m.provider).toHaveBeenCalledTimes(1);
  });
  it('keeps another ordinary chat waiter blocked through provider and commit', async () => {
    let resolve!: (v: unknown) => void;
    m.provider.mockReturnValue(new Promise((r) => { resolve = r; }));
    const running = tryVoiceFastDirect(input());
    await vi.waitFor(() => expect(m.provider).toHaveBeenCalled());
    let acquired = false;
    const waiter = acquireSessionAdmissionLock('s').then((release) => { acquired = true; release(); });
    await Promise.resolve(); expect(acquired).toBe(false);
    resolve({ kind: 'direct', answer: '안녕' }); await running; await waiter;
    expect(acquired).toBe(true); expect(m.commit).toHaveBeenCalledTimes(1);
  });
  it('isolates Sessions and refuses active ordinary root before model work', async () => {
    m.active.mockResolvedValue({ state: 'running', rootTurnId: 'normal' });
    await expect(tryVoiceFastDirect(input())).rejects.toThrow('VOICE_BUSY');
    expect(m.provider).not.toHaveBeenCalled(); expect(m.commit).not.toHaveBeenCalled();
  });
  it('cancel during fast inference never stores or returns a late reply', async () => {
    const abort = new AbortController(); m.provider.mockReturnValue(new Promise(() => {}));
    const rejected = expect(tryVoiceFastDirect({ ...input(), signal: abort.signal })).rejects.toMatchObject({ code: 'VOICE_CANCELLED' });
    await vi.waitFor(() => expect(m.provider).toHaveBeenCalled()); abort.abort(); await rejected;
    expect(m.commit).not.toHaveBeenCalled();
  });
  it('does not fall through on uncertain durable commit failure', async () => {
    m.commit.mockRejectedValue(new Error('commit-failed')); await expect(tryVoiceFastDirect(input())).rejects.toThrow('commit-failed');
    expect(m.commit).toHaveBeenCalledTimes(1);
  });
});
