import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../engines/index.js', () => ({ getEngine: vi.fn() }));
vi.mock('../../config.js', () => ({ loadModelsFile: vi.fn(), isPiModelEntrySelectableForThisVm: vi.fn() }));
vi.mock('../../engines/pi/provider-boundary.js', () => ({ isAllowedTowerPiModel: vi.fn() }));
vi.mock('../model-policy/session-alias.js', () => ({ resolvePiSessionChoice: vi.fn() }));
vi.mock('../ai/litellm-credentials.js', () => ({ resolveLiteLLMCredentials: vi.fn() }));
vi.mock('../ai/inference-provider-setup.js', () => ({ resolveConfiguredInferenceProviderSecret: vi.fn() }));
vi.mock('../gateway-profile/gateway-profile-client.js', () => ({ resolveGatewayProfileClient: vi.fn() }));
vi.mock('../decision/openrouter-jev-adapter.js', () => ({ evaluateWithOpenRouterJev: vi.fn() }));
import { getEngine } from '../../engines/index.js';
import { loadModelsFile, isPiModelEntrySelectableForThisVm } from '../../config.js';
import { isAllowedTowerPiModel } from '../../engines/pi/provider-boundary.js';
import { resolvePiSessionChoice } from '../model-policy/session-alias.js';
import { resolveLiteLLMCredentials } from '../ai/litellm-credentials.js';
import { resolveGatewayProfileClient } from '../gateway-profile/gateway-profile-client.js';
import { evaluateWithOpenRouterJev } from '../decision/openrouter-jev-adapter.js';
import { parseProposal, safeCandidate, prepareProviders, MAX_OUTPUT_TOKENS, PROVIDER_TIMEOUT_MS } from './provider.js';
const candidate = { id: 'work', title: '초안', outcome: '비교표 작성', sourceKey: 'key', projectId: 'project', sessionId: 'session', updatedAt: 'now' };
const quickReply = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveGatewayProfileClient).mockResolvedValue({ apiKey: 'synthetic-key', baseUrl: 'https://gateway.example.com' } as any);
  vi.mocked(resolvePiSessionChoice).mockReturnValue('litellm-responses/mini');
  vi.mocked(loadModelsFile).mockReturnValue({ pi: [{ provider: 'litellm-responses', modelId: 'mini', enabled: true }] } as any);
  vi.mocked(isAllowedTowerPiModel).mockReturnValue(true); vi.mocked(isPiModelEntrySelectableForThisVm).mockReturnValue(true);
  vi.mocked(resolveLiteLLMCredentials).mockResolvedValue({ apiKey: 'synthetic-key', baseUrl: 'https://router.example.com' });
  vi.mocked(getEngine).mockResolvedValue({ quickReply } as any);
  quickReply.mockResolvedValue(JSON.stringify({ title: '비교표 준비', body: '비교 기준을 먼저 정할까요?', delivery: 'popup', benefit: 'comparison', evidence: 'stated goal', whyNow: 'decision needed', userBurden: 'one choice' }));
  vi.mocked(evaluateWithOpenRouterJev).mockResolvedValue({ disposition: 'accepted', answers: {
    candidate_0: { type: 'noul', noul: 0.9 },
  } } as any);
});
describe('Secretariat bounded provider', () => {
  it('resolves explicit Lite, both connections before billable calls, and current Project gateway', async () => {
    const p = await prepareProviders(7, 'project');
    expect(resolvePiSessionChoice).toHaveBeenCalledWith('preset/lite');
    expect(resolveGatewayProfileClient).toHaveBeenCalledWith({ actorUserId: 7, projectId: 'project' });
    expect(resolveLiteLLMCredentials).toHaveBeenCalledOnce(); expect(evaluateWithOpenRouterJev).not.toHaveBeenCalled();
    expect(await p.choose([candidate])).toEqual({ id: 'work', score: 0.9 });
    const [spec, state, options] = vi.mocked(evaluateWithOpenRouterJev).mock.calls[0];
    expect(spec.policy.minConfidence).toBe(0.7); expect(spec.questions.candidate_0.type).toBe('noul');
    expect(state).toEqual({ candidates: [{ id: 'candidate_0', title: '초안', outcome: '비교표 작성' }] });
    expect(options).toMatchObject({ timeoutMs: 3000, baseUrl: 'https://gateway.example.com' });
  });
  it('uses supported Pi quickReply without a session, tools, or proactive engine', async () => {
    const p = await prepareProviders(7, 'project');
    expect(await p.write(candidate)).toEqual({ title: '비교표 준비', body: '비교 기준을 먼저 정할까요?', delivery: 'popup' });
    const [prompt, opts] = quickReply.mock.calls[0];
    expect(JSON.parse(prompt)).toMatchObject({ title: '초안', outcome: '비교표 작성' });
    expect(opts.model).toBe('litellm-responses/mini'); expect(opts.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
    expect(opts.signal).toBeInstanceOf(AbortSignal); expect(opts.systemPrompt).toContain('recent visible conversation');
    expect(PROVIDER_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });
  it('does not fall back to another model when Lite mapping is disabled or unsupported', async () => {
    vi.mocked(isPiModelEntrySelectableForThisVm).mockReturnValue(false);
    await expect(prepareProviders(7, 'project')).rejects.toThrow();
    expect(evaluateWithOpenRouterJev).not.toHaveBeenCalled(); expect(quickReply).not.toHaveBeenCalled();
  });
  it('fails before Jev if Lite connection is unconfigured', async () => {
    vi.mocked(resolveLiteLLMCredentials).mockRejectedValue(new Error('unconfigured'));
    await expect(prepareProviders(7, 'project')).rejects.toThrow(); expect(evaluateWithOpenRouterJev).not.toHaveBeenCalled();
  });
  it.each(['stay_silent', 'flag_change', 'invented'])('never consumes unsupported direction %s without evidence', async direction => {
    vi.mocked(evaluateWithOpenRouterJev).mockResolvedValue({ disposition: 'accepted', answers: {
      source: { type: 'choice', choice: 'candidate_0' }, direction: { type: 'choice', choice: direction },
    } } as any);
    expect(await (await prepareProviders(7, 'project')).choose([candidate])).toBeNull();
  });
  it.each(['abstained', 'needs_human', 'observed', 'fallback'])('does not turn %s into authority or a suggestion', async disposition => {
    vi.mocked(evaluateWithOpenRouterJev).mockResolvedValue({ disposition } as any);
    expect(await (await prepareProviders(7, 'project')).choose([candidate])).toBeNull();
  });
  it('silences none/unknown source and missing direction', async () => {
    const p = await prepareProviders(7, 'project');
    for (const source of ['none', 'unknown']) {
      vi.mocked(evaluateWithOpenRouterJev).mockResolvedValue({ disposition: 'accepted', answers: {
        source: { type: 'choice', choice: source }, direction: { type: 'choice', choice: 'make_next_step_smaller' },
      } } as any); expect(await p.choose([candidate])).toBeNull();
    }
  });
});
describe('safe proposal parsing', () => {
  it('requires strict parseable grounded-question format', () => {
    expect(parseProposal('{}')).toBeNull(); expect(parseProposal('plain prose')).toBeNull();
    expect(parseProposal(JSON.stringify({ title: 'title', body: '두 가지 선택지가 있습니다.', delivery: 'inbox', benefit: 'b', evidence: 'e', whyNow: 'not urgent', userBurden: 'low' }))).not.toBeNull();
    expect(parseProposal('{"title":"title","body":"비교 기준을 정할까요?"}')).toBeNull();
  });
  it('rejects overlong, generated external links, markup, and credential-shaped output', () => {
    for (const body of ['a'.repeat(4001) + '?', 'https://example.com 볼까요?', '<script>할까요?', 'password: synthetic 볼까요?']) {
      expect(parseProposal(JSON.stringify({ title: 'title', body }))).toBeNull();
    }
    expect(safeCandidate({ ...candidate, outcome: 'password: synthetic' })).toBe(false);
  });
});

it('forwards visible context but withholds secret-pattern messages', async () => {
  const provider = await prepareProviders(7, 'project');
  await provider.write(candidate, [{ role: 'user', text: '두 안을 비교해주세요.' }, { role: 'user', text: 'password: sensitive' }]);
  const prompt = JSON.parse(quickReply.mock.calls[0][0]);
  expect(prompt.recentConversation).toEqual([{ role: 'user', text: '두 안을 비교해주세요.' }]);
});

it('passes catalog freshness to model selection', async () => {
  const models = loadModelsFile();
  vi.mocked(loadModelsFile).mockReturnValue({ ...models, litellmCatalog: { syncedAt: 'current' } } as any);
  await prepareProviders(7, 'project');
  expect(isPiModelEntrySelectableForThisVm).toHaveBeenCalledWith(expect.anything(), 'current');
});

it('ranks independent candidate values without direction competition', async () => {
  vi.mocked(evaluateWithOpenRouterJev).mockResolvedValue({ disposition: 'accepted', answers: {
    candidate_0: { type: 'noul', noul: 0.8 }, candidate_1: { type: 'noul', noul: 0.9 },
  } } as any);
  const p = await prepareProviders(7, 'project');
  expect(await p.choose([candidate, { ...candidate, id: 'second' }])).toEqual({ id: 'second', score: 0.9 });
});
it('keeps empty inputs unbilled and requires Lite to independently gate delivery', async () => {
  const p = await prepareProviders(7, 'project');
  expect(await p.choose([])).toBeNull();
  expect(evaluateWithOpenRouterJev).not.toHaveBeenCalled();
  quickReply.mockResolvedValue('null');
  expect(await p.write(candidate)).toBeNull();
  expect(quickReply.mock.calls[0][1].systemPrompt).toContain('not a finding or a command to notify');
});
