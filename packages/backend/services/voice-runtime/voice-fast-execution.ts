/** Fast routing and atomic direct completion under the existing chat/recovery admission mutex. */
import { acquireSessionAdmissionLock } from '../agent-turn/session-admission-lock.js';
import { getActiveAgentTurnTiming } from '../agent-turn/turn-supervisor.js';
import { getEngine } from '../../engines/index.js';
import { getSession } from '../session/session-manager.js';
import { queryOne } from '../../db/pg-repo.js';
import { canAccessSession } from '../pm/project-access.js';
import { routeFastVoice, readFastVoiceConfig, FastVoiceBoundaryError, fastVoiceIntent, type FastVoiceIdentity } from './voice-fast-router.js';
import { voiceFastProvider } from './voice-fast-provider.js';
import { commitVoiceFastDirect } from './voice-fast-store.js';

export async function tryVoiceFastDirect(input: FastVoiceIdentity & { transcript: string; signal: AbortSignal }) {
  const config = readFastVoiceConfig(process.env);
  if (!config.enabled || !config.model || !fastVoiceIntent(input.transcript)) return undefined;
  const release = await acquireSessionAdmissionLock(input.sessionId);
  try {
    input.signal.throwIfAborted();
    const session = await getSession(input.sessionId);
    if (!session) throw new FastVoiceBoundaryError('VOICE_UNAUTHORIZED');
    const engine = await getEngine(session.engine || 'pi');
    const active = await getActiveAgentTurnTiming(input.sessionId);
    if (engine.isRunning(input.sessionId) || (active && ['running','waiting_retry','stop_requested'].includes(active.state))) throw new Error('VOICE_BUSY');
    let username = 'voice';
    const authorize = async (identity: FastVoiceIdentity) => {
      if (input.signal.aborted || identity.sessionId !== input.sessionId || identity.userId !== input.userId) return false;
      const actor = await queryOne<{ username: string; role: string }>('SELECT username, role FROM users WHERE id = $1', [input.userId]);
      if (!actor) return false;
      username = actor.username;
      return (await canAccessSession(input.sessionId, input.userId, actor.role)).allowed;
    };
    const result = await routeFastVoice({ identity: input, transcript: input.transcript, signal: input.signal }, { config, provider: voiceFastProvider, authorize });
    input.signal.throwIfAborted();
    if (result.kind !== 'direct_candidate') return undefined; // no message has been saved; handleChat owns the single write
    const committed = await commitVoiceFastDirect({ ...input, answer: result.decision.answer, username, model: config.model });
    input.signal.throwIfAborted(); // commit may already be durable; never emit cancelled speech
    return { assistantText: result.decision.answer, assistantMessageId: committed.assistantMessageId };
  } finally { release(); }
}
