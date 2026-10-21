import { getModelDefaults } from '../../config.js';
import { runUtilityTextTask } from '../ai/utility-agent.js';
import { parseDecisionSpec } from '../decision/decision-spec.js';
import { evaluateWithOpenRouterJev } from '../decision/openrouter-jev-adapter.js';
import { resolveGatewayProfileClient } from '../gateway-profile/gateway-profile-client.js';

export interface UserReplyCandidate {
  id: string;
  message: string;
  label: string;
}

export interface UserReplyCandidateResult {
  candidates: UserReplyCandidate[];
  recommendedId: string | null;
  confidence?: number;
  disposition?: string;
}

const cache = new Map<string, Promise<UserReplyCandidateResult>>();
const PROHIBITED_ACTION = /(배포|삭제|결제|구매|송금|비밀번호|credential|deploy|delete|purchase|payment|approve|승인)/i;

function cleanCandidate(value: unknown, index: number): UserReplyCandidate | null {
  if (typeof value !== 'string') return null;
  const message = value.trim().replace(/^[-*\d.)\s]+/, '').replace(/^['"]|['"]$/g, '');
  if (!message || message.length > 120 || PROHIBITED_ACTION.test(message)) return null;
  return { id: `reply_${index + 1}`, message, label: message };
}

export function parseUserReplyCandidates(raw: string): UserReplyCandidate[] {
  try {
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    const values = Array.isArray(parsed) ? parsed : parsed?.candidates;
    if (!Array.isArray(values)) return [];
    const seen = new Set<string>();
    return values.map(cleanCandidate).filter((candidate): candidate is UserReplyCandidate => {
      if (!candidate || seen.has(candidate.message)) return false;
      seen.add(candidate.message);
      return true;
    }).slice(0, 3).map((candidate, index) => ({ ...candidate, id: `reply_${index + 1}` }));
  } catch {
    return [];
  }
}

async function generate(input: {
  sessionId: string;
  responseMessageId: string;
  latestUserText: string;
  latestAssistantText: string;
  language: string;
  actorUserId: number;
  projectId: string;
}): Promise<UserReplyCandidateResult> {
  const raw = await runUtilityTextTask({
    model: getModelDefaults().ai_reply,
    timeoutMs: 4_000,
    fallbackText: '[]',
    systemPrompt: [
      'Generate 2 or 3 short messages the HUMAN USER might naturally choose to send next.',
      'Each candidate must be a concrete first-person user utterance grounded in the latest exchange, not an assistant control label.',
      'Candidates must differ in intent: for example proceed with a named next step, ask a specific question, or correct/clarify a concrete point.',
      'Do not invent approval, deployment, deletion, purchase, credential, destructive, financial, or irreversible authority.',
      'Do not use generic phrases such as continue, improve result, replan, tell me more, or equivalent bare control commands.',
      'Return strict JSON only: {"candidates":["message 1","message 2","message 3"]}. Each message must be under 80 Korean characters or 16 English words.',
    ].join(' '),
    prompt: `<LATEST_USER>${input.latestUserText.slice(-2000)}</LATEST_USER>\n<LATEST_ASSISTANT>${input.latestAssistantText.slice(-4000)}</LATEST_ASSISTANT>\n<LANGUAGE>${input.language}</LANGUAGE>`,
  });
  const candidates = parseUserReplyCandidates(raw);
  if (candidates.length < 2) return { candidates: [], recommendedId: null };

  try {
    const criteria = Object.fromEntries(candidates.map(candidate => [candidate.id, `The user would naturally send: ${candidate.message}`]));
    const spec = parseDecisionSpec({
      schemaVersion: 1,
      id: 'tower.session-navigator.user-reply',
      revision: 1,
      purpose: 'Recommend one already-generated bounded user reply candidate without inventing user intent or authority.',
      mode: 'advisory',
      state: { maxBytes: 12_000, allowedData: ['session'], prohibitedFields: ['api_key', 'authorization', 'credential', 'password', 'private_key', 'secret', 'token'] },
      questions: { reply: { type: 'choice', instructions: 'Choose the candidate that best matches the user’s likely next conversational intent. This is advisory only and is not user consent.', criteria } },
      policy: { minConfidence: 0.65, confidenceQuestionIds: ['reply'], onAbstain: 'observe_only' },
      tags: ['session-navigation', 'user-reply', 'composer'],
    });
    const gateway = await resolveGatewayProfileClient({ actorUserId: input.actorUserId, projectId: input.projectId });
    const decision = await evaluateWithOpenRouterJev(spec, {
      sessionId: input.sessionId,
      responseMessageId: input.responseMessageId,
      latestUserText: input.latestUserText.slice(-2000),
      latestAssistantText: input.latestAssistantText.slice(-4000),
      candidates,
    }, { apiKey: gateway.apiKey, baseUrl: gateway.baseUrl, timeoutMs: 2_000 });
    const answer = decision.answers.reply;
    return {
      candidates,
      recommendedId: decision.disposition === 'accepted' && answer?.type === 'choice' ? answer.choice : null,
      confidence: answer && 'confidence' in answer ? answer.confidence : undefined,
      disposition: decision.disposition,
    };
  } catch {
    return { candidates, recommendedId: null };
  }
}

export function getUserReplyCandidates(input: Parameters<typeof generate>[0]): Promise<UserReplyCandidateResult> {
  const key = `${input.sessionId}:${input.responseMessageId}:${input.language}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const work = generate(input);
  cache.set(key, work);
  return work;
}

export function resetUserReplyCandidateCacheForTests(): void {
  cache.clear();
}
