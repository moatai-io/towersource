import { encodeDecisionState, type DecisionAnswer, type DecisionResult, type DecisionSpec } from './decision-spec.js';

export interface OpenRouterJevAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class DecisionProviderError extends Error {
  constructor(message: string, readonly code = 'DECISION_PROVIDER_ERROR') {
    super(message);
    this.name = 'DecisionProviderError';
  }
}

type RawAnswer = Record<string, unknown>;

function finiteProbability(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new DecisionProviderError(`Invalid ${label}`, 'DECISION_RESPONSE_INVALID');
  }
  return value;
}

function rawAnswers(body: unknown): Record<string, RawAnswer> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DecisionProviderError('Invalid Decisions response', 'DECISION_RESPONSE_INVALID');
  const answers = (body as Record<string, unknown>).answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new DecisionProviderError('Decisions response answers missing', 'DECISION_RESPONSE_INVALID');
  return answers as Record<string, RawAnswer>;
}

function mapAnswer(question: DecisionSpec['questions'][string], raw: RawAnswer): DecisionAnswer {
  if (raw.type !== question.type) throw new DecisionProviderError('Decision answer type mismatch', 'DECISION_RESPONSE_INVALID');
  if (question.type === 'noul') return { type: 'noul', noul: finiteProbability(raw.noul, 'noul') };
  const probabilities = raw.probabilities;
  if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) throw new DecisionProviderError('Decision probabilities missing', 'DECISION_RESPONSE_INVALID');
  const mapped = Object.fromEntries(Object.entries(probabilities).map(([key, value]) => [key, finiteProbability(value, `probability ${key}`)]));
  const confidence = finiteProbability(raw.confidence, 'confidence');
  if (question.type === 'choice') {
    if (typeof raw.choice !== 'string' || !(raw.choice in question.criteria)) throw new DecisionProviderError('Decision choice is not in spec', 'DECISION_RESPONSE_INVALID');
    return { type: 'choice', choice: raw.choice, probabilities: mapped, confidence };
  }
  const legend = raw.legend;
  if (!legend || typeof legend !== 'object' || Array.isArray(legend)) throw new DecisionProviderError('Decision score legend missing', 'DECISION_RESPONSE_INVALID');
  if (typeof raw.score !== 'number' || !Number.isFinite(raw.score)) throw new DecisionProviderError('Decision score invalid', 'DECISION_RESPONSE_INVALID');
  return { type: 'score', score: raw.score, probabilities: mapped, confidence, legend: Object.fromEntries(Object.entries(legend).map(([k, v]) => [k, String(v)])) };
}

export async function evaluateWithOpenRouterJev(spec: DecisionSpec, state: unknown, options: OpenRouterJevAdapterOptions): Promise<DecisionResult> {
  if (!options.apiKey.trim()) throw new DecisionProviderError('OpenRouter API key required', 'DECISION_AUTH_REQUIRED');
  const encodedState = encodeDecisionState(state);
  if (Buffer.byteLength(encodedState, 'utf8') > spec.state.maxBytes) throw new DecisionProviderError('Decision state exceeds spec maxBytes', 'DECISION_STATE_TOO_LARGE');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  const started = Date.now();
  try {
    const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl ?? 'https://openrouter.ai'}/api/alpha/decisions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'typesafe/jev-1.13', state: JSON.parse(encodedState), questions: spec.questions }),
      signal: controller.signal,
    });
    const body = await response.json() as unknown;
    if (!response.ok) throw new DecisionProviderError(`OpenRouter Decisions request failed (${response.status})`, `DECISION_HTTP_${response.status}`);
    const answers = rawAnswers(body);
    const mapped: Record<string, DecisionAnswer> = {};
    for (const [id, question] of Object.entries(spec.questions)) {
      const raw = answers[id];
      if (!raw) throw new DecisionProviderError(`Missing answer: ${id}`, 'DECISION_RESPONSE_INVALID');
      mapped[id] = mapAnswer(question, raw);
    }
    const confidenceIds = spec.policy.confidenceQuestionIds.length > 0 ? spec.policy.confidenceQuestionIds : Object.keys(mapped);
    const confidenceAnswers = confidenceIds.map((id) => mapped[id]).filter((answer): answer is Extract<DecisionAnswer, { confidence: number }> => Boolean(answer) && 'confidence' in answer);
    const accepted = confidenceAnswers.every((answer) => answer.confidence >= spec.policy.minConfidence);
    const disposition = accepted ? 'accepted' : spec.policy.onAbstain === 'fallback' ? 'fallback' : spec.policy.onAbstain === 'needs_human' ? 'needs_human' : 'observed';
    const rawBody = body as Record<string, unknown>;
    const usage = rawBody.usage as Record<string, unknown> | undefined;
    return { specId: spec.id, specRevision: spec.revision, provider: String(rawBody.provider ?? 'OpenRouter'), model: String(rawBody.model ?? 'typesafe/jev-1.13'), latencyMs: Date.now() - started, answers: mapped, disposition, usage: usage ? { inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined, outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined, costUsd: typeof usage.cost === 'number' ? usage.cost : undefined } : undefined };
  } catch (error) {
    if (error instanceof DecisionProviderError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw new DecisionProviderError('Decision request timed out or was aborted', 'DECISION_ABORTED');
    throw new DecisionProviderError(error instanceof Error ? error.message : 'Decision request failed');
  } finally { clearTimeout(timeout); }
}
