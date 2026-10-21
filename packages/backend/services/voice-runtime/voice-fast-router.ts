/** Bounded backend-only fast-routing seam. NOT a persistence/execution entry point.
 * Provider adapters are injected here; direct candidates must be durably committed
 * by a future shared admission owner before any text is sent to the voice worker.
 */
import { z } from 'zod';

export const FastVoiceDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct'), answer: z.string().trim().min(1).max(400) }).strict(),
  z.object({ kind: z.literal('delegate') }).strict(),
]);
export type FastVoiceDecision = z.infer<typeof FastVoiceDecisionSchema>;
export type FastVoiceIntent = 'greeting' | 'thanks' | 'farewell';
export interface FastVoiceIdentity {
  voiceSessionId: string; sessionId: string; userId: number; turnId: string; revision: number;
}
export interface FastVoiceConfig { enabled: boolean; model?: string; timeoutMs: number }
export function readFastVoiceConfig(env: Record<string, string | undefined>): FastVoiceConfig {
  const model = env.TOWER_VOICE_FAST_MODEL?.trim();
  return {
    enabled: env.TOWER_VOICE_FAST_ENABLED === 'true',
    model: model && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/.test(model) ? model : undefined,
    timeoutMs: 1500,
  };
}
export interface FastVoiceProviderRequest {
  model: string;
  /** Only canonical social intent, never raw transcript, history, identity or tool context. */
  intent: FastVoiceIntent;
  instructions: string;
  tools: readonly [];
  toolChoice: 'none';
  maxOutputTokens: 160;
  signal: AbortSignal;
}
export interface FastVoiceProvider {
  /** Trusted backend adapter. Must not attach tools or ambient Session context. */
  decide(request: FastVoiceProviderRequest): Promise<unknown>;
}
export type FastVoiceRoute =
  | { kind: 'direct_candidate'; decision: Extract<FastVoiceDecision, { kind: 'direct' }>; requiresDurableCommit: true }
  | { kind: 'delegate'; reason: 'disabled' | 'model_missing' | 'provider_missing' | 'context_required' | 'provider_delegate' | 'invalid_result' | 'provider_failed' | 'timeout' };
export class FastVoiceBoundaryError extends Error {
  constructor(readonly code: 'VOICE_CANCELLED' | 'VOICE_UNAUTHORIZED') { super(code); }
}

/** Positive finite allowlist, not a denylist/model judgement security boundary.
 * Any qualifiers/history/latest/tools/ambiguous reference → delegate without provider.
 * Broader context-free conversation remains intentionally unimplemented in v1.
 */
export function fastVoiceIntent(transcript: string): FastVoiceIntent | undefined {
  const text = transcript.normalize('NFKC').trim().toLowerCase().replace(/[.!?。！？]+$/u, '').trim();
  if (['안녕', '안녕하세요', '반가워', '반갑습니다', 'hello', 'hi'].includes(text)) return 'greeting';
  if (['고마워', '고맙습니다', '감사합니다', 'thank you', 'thanks'].includes(text)) return 'thanks';
  if (['잘 가', '안녕히 계세요', '안녕히 가세요', 'goodbye', 'bye'].includes(text)) return 'farewell';
  return undefined;
}
const INSTRUCTIONS = 'Return JSON only: {"kind":"direct","answer":"short Korean social reply"} or {"kind":"delegate"}. Respond only to the supplied canonical social intent. No factual claims, promises of action, tools, history, personal data, or partial_then_delegate.';

/** Pure routing decision with injected auth/provider. Never stores a user message, calls
 * handleChat or emits speech. Caller must retain the same owner/admission through commit.
 */
export async function routeFastVoice(input: {
  identity: FastVoiceIdentity;
  transcript: string;
  /** Omit only when no recent/contextual data was consulted. Context-dependent inputs delegate. */
  requiresContext?: boolean;
  signal: AbortSignal;
}, deps: {
  config: FastVoiceConfig;
  provider?: FastVoiceProvider;
  /** Must revalidate current actor, voice descriptor, Session ACL and exact ownership. */
  authorize: (identity: FastVoiceIdentity) => Promise<boolean>;
}): Promise<FastVoiceRoute> {
  const checkCancel = () => { if (input.signal.aborted) throw new FastVoiceBoundaryError('VOICE_CANCELLED'); };
  checkCancel();
  if (!deps.config.enabled) return { kind: 'delegate', reason: 'disabled' };
  if (!deps.config.model) return { kind: 'delegate', reason: 'model_missing' };
  if (!deps.provider) return { kind: 'delegate', reason: 'provider_missing' };
  const identity = { voiceSessionId: input.identity.voiceSessionId, sessionId: input.identity.sessionId,
    userId: input.identity.userId, turnId: input.identity.turnId, revision: input.identity.revision };
  // No fast work is allowed on the strength of a model classification/token alone.
  const allowed = await deps.authorize(identity);
  checkCancel();
  if (!allowed) throw new FastVoiceBoundaryError('VOICE_UNAUTHORIZED');
  const intent = input.requiresContext ? undefined : fastVoiceIntent(input.transcript);
  if (!intent) return { kind: 'delegate', reason: 'context_required' };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detach = () => {};
  let timedOut = false;
  try {
    const stopped = new Promise<never>((_, reject) => {
      const abort = () => { controller.abort(); reject(new FastVoiceBoundaryError('VOICE_CANCELLED')); };
      input.signal.addEventListener('abort', abort, { once: true });
      detach = () => input.signal.removeEventListener('abort', abort);
      if (input.signal.aborted) { abort(); return; }
      // A trusted config still cannot turn a small route probe into an unbounded wait.
      const timeoutMs = Number.isFinite(deps.config.timeoutMs) ? Math.max(1, Math.min(3000, deps.config.timeoutMs)) : 1500;
      timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('fast-timeout')); }, timeoutMs);
    });
    const answer = await Promise.race([
      Promise.resolve().then(() => {
        checkCancel();
        return deps.provider!.decide({ model: deps.config.model!, intent, instructions: INSTRUCTIONS,
          tools: Object.freeze([]) as readonly [], toolChoice: 'none', maxOutputTokens: 160, signal: controller.signal });
      }),
      stopped,
    ]);
    checkCancel();
    let value = answer;
    if (typeof answer === 'string') {
      if (answer.length > 4096) return { kind: 'delegate', reason: 'invalid_result' };
      try { value = JSON.parse(answer); } catch { return { kind: 'delegate', reason: 'invalid_result' }; }
    }
    const decision = FastVoiceDecisionSchema.safeParse(value);
    if (!decision.success) return { kind: 'delegate', reason: 'invalid_result' };
    if (decision.data.kind === 'delegate') return { kind: 'delegate', reason: 'provider_delegate' };
    // Recheck authority after model work; a valid result is not permanent permission.
    let stillAllowed = false;
    try { stillAllowed = await deps.authorize(identity); }
    catch { throw new FastVoiceBoundaryError('VOICE_UNAUTHORIZED'); }
    checkCancel();
    if (!stillAllowed) throw new FastVoiceBoundaryError('VOICE_UNAUTHORIZED');
    return { kind: 'direct_candidate', decision: decision.data, requiresDurableCommit: true };
  } catch (error) {
    checkCancel();
    if (error instanceof FastVoiceBoundaryError) throw error;
    return { kind: 'delegate', reason: timedOut ? 'timeout' : 'provider_failed' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    detach();
    controller.abort();
  }
}
