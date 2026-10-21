import { describe, expect, it, vi } from 'vitest';
import { TOWER_REQUEST_ROUTING_SPEC } from './examples.js';
import { DecisionProviderError, evaluateWithOpenRouterJev } from './openrouter-jev-adapter.js';

const response = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as Response;
const answers = {
  route: { type: 'choice', choice: 'external_action', probabilities: { quick_reply: 0.1, analysis: 0.1, code_change: 0, external_action: 0.8, needs_human: 0 }, confidence: 0.9 },
  needs_fresh_data: { type: 'noul', noul: 0.99 },
  complexity: { type: 'score', score: 1.1, probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 }, confidence: 0.85, legend: { '0': 'Trivial', '1': 'Moderate', '2': 'Complex' } },
};

describe('OpenRouter Jev adapter', () => {
  it('maps Decisions API output to Tower DecisionResult', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ model: 'typesafe/jev-1.13-20260917', provider: 'TypeSafe', answers, usage: { input_tokens: 10, output_tokens: 3, cost: 0.00001 } }));
    const result = await evaluateWithOpenRouterJev(TOWER_REQUEST_ROUTING_SPEC, { request: 'weather' }, { apiKey: 'test', fetchImpl });
    expect(result).toMatchObject({ specId: 'tower.request-routing', specRevision: 1, provider: 'TypeSafe', model: 'typesafe/jev-1.13-20260917', disposition: 'accepted', usage: { inputTokens: 10, outputTokens: 3, costUsd: 0.00001 } });
    expect(result.answers.route).toMatchObject({ type: 'choice', choice: 'external_action', confidence: 0.9 });
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/api/alpha/decisions'), expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }));
  });

  it('abstains according to the configured gating question confidence', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ answers: { ...answers, route: { ...answers.route, confidence: 0.2 } } }));
    const result = await evaluateWithOpenRouterJev(TOWER_REQUEST_ROUTING_SPEC, {}, { apiKey: 'test', fetchImpl });
    expect(result.disposition).toBe('fallback');
  });

  it('does not let an observational score confidence reject a confident route', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ answers: { ...answers, complexity: { ...answers.complexity, confidence: 0.2 } } }));
    const result = await evaluateWithOpenRouterJev(TOWER_REQUEST_ROUTING_SPEC, {}, { apiKey: 'test', fetchImpl });
    expect(result.disposition).toBe('accepted');
  });

  it('rejects malformed provider answers and HTTP failures', async () => {
    const malformed = vi.fn().mockResolvedValue(response({ answers: { ...answers, route: { ...answers.route, choice: 'not-in-spec' } } }));
    await expect(evaluateWithOpenRouterJev(TOWER_REQUEST_ROUTING_SPEC, {}, { apiKey: 'test', fetchImpl: malformed })).rejects.toMatchObject({ code: 'DECISION_RESPONSE_INVALID' });
    const failed = vi.fn().mockResolvedValue(response({ error: { message: 'bad' } }, false, 401));
    await expect(evaluateWithOpenRouterJev(TOWER_REQUEST_ROUTING_SPEC, {}, { apiKey: 'test', fetchImpl: failed })).rejects.toMatchObject({ code: 'DECISION_HTTP_401' });
  });

  it('enforces state size and timeout/abort', async () => {
    const tooLarge = { ...TOWER_REQUEST_ROUTING_SPEC, state: { ...TOWER_REQUEST_ROUTING_SPEC.state, maxBytes: 1 } };
    await expect(evaluateWithOpenRouterJev(tooLarge, { request: 'too large' }, { apiKey: 'test', fetchImpl: vi.fn() })).rejects.toMatchObject({ code: 'DECISION_STATE_TOO_LARGE' });
    const abort = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
    await expect(evaluateWithOpenRouterJev(TOWER_REQUEST_ROUTING_SPEC, {}, { apiKey: 'test', fetchImpl: abort, timeoutMs: 1 })).rejects.toMatchObject({ code: 'DECISION_ABORTED' });
  });

  it('exposes a typed provider error for missing credentials', async () => {
    await expect(evaluateWithOpenRouterJev(TOWER_REQUEST_ROUTING_SPEC, {}, { apiKey: '  ' })).rejects.toBeInstanceOf(DecisionProviderError);
  });
});
