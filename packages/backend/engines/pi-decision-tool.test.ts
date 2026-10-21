import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/project-environment/project-workspace-files.js', () => ({ resolveProjectWorkspaceFile: vi.fn(), readProjectWorkspaceFileBytes: vi.fn() }));
import { resolveProjectWorkspaceFile, readProjectWorkspaceFileBytes } from '../services/project-environment/project-workspace-files.js';
import { createDecisionEvaluateTool } from './pi-decision-tool.js';

vi.mock('../services/gateway-profile/gateway-profile-client.js', () => ({
  resolveGatewayProfileClient: vi.fn(),
}));
import { resolveGatewayProfileClient } from '../services/gateway-profile/gateway-profile-client.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(resolveGatewayProfileClient).mockReset();
});

describe('decision_evaluate Pi tool', () => {
  it('exposes a provider-neutral raw decision tool', () => {
    const tool = createDecisionEvaluateTool({ userId: 1, projectId: 'project-1', sessionId: 'session-1' });
    expect(tool.name).toBe('decision_evaluate');
    expect(tool.parameters).toBeDefined();
  });

  it('maps a provider response into the compact Pi tool result', async () => {
    vi.mocked(resolveGatewayProfileClient).mockResolvedValue({ profileId: 'tower-shared-api-v1', baseUrl: 'https://gateway.example.com/inference/openrouter', credentialId: 'tower-key', apiKey: 'test-key' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      provider: 'TypeSafe',
      model: 'typesafe/jev-1.13-20260917',
      answers: {
        route: { type: 'choice', choice: 'quick_reply', probabilities: { quick_reply: 0.98, needs_human: 0.02 }, confidence: 0.98 },
      },
      usage: { input_tokens: 20, output_tokens: 8, cost: 0.000001 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const tool = createDecisionEvaluateTool({ userId: 1, projectId: 'project-1', sessionId: 'session-1' });
    const result = await tool.execute('call-1', {
      state: { request: 'Say hello.' },
      questions: { route: { type: 'choice', instructions: 'Choose a route.', criteria: { quick_reply: 'Can answer now.', needs_human: 'Cannot answer safely.' } } },
    } as never, new AbortController().signal);
    const text = (result as any).content[0].text;
    expect(JSON.parse(text)).toMatchObject({ disposition: 'accepted', provider: 'TypeSafe', answers: { route: { choice: 'quick_reply' } } });
  });

  it('rejects secret-like fields before provider access', async () => {
    vi.mocked(resolveGatewayProfileClient).mockResolvedValue({ profileId: 'tower-shared-api-v1', baseUrl: 'https://gateway.example.com/inference/openrouter', credentialId: 'tower-key', apiKey: 'test-key' });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const tool = createDecisionEvaluateTool({ userId: 1, projectId: 'project-1', sessionId: 'session-1' });
    const result = await tool.execute('call-1', {
      state: { request: 'route this', apiKey: 'must-not-send' },
      questions: { route: { type: 'choice', instructions: 'Choose', criteria: { yes: 'yes', no: 'no' } } },
    } as never, new AbortController().signal);
    expect(JSON.stringify(result)).toContain('DECISION_SECRET_FIELD');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['credentials domain label', { candidates: { project_credentials: { status: 'configured', materialized: false } } }],
    ['credential metadata', { credentialId: 'project-openai', credentialStatus: 'configured', provider: 'openai' }],
  ])('allows non-secret %s', async (_label, state) => {
    vi.mocked(resolveGatewayProfileClient).mockResolvedValue({ profileId: 'tower-shared-api-v1', baseUrl: 'https://gateway.example.com/inference/openrouter', credentialId: 'tower-key', apiKey: 'test-key' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      provider: 'TypeSafe',
      model: 'typesafe/jev-1.13-20260917',
      answers: { route: { type: 'choice', choice: 'inspect', probabilities: { inspect: 0.99, needs_human: 0.01 }, confidence: 0.98 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const tool = createDecisionEvaluateTool({ userId: 1, projectId: 'project-1', sessionId: 'session-1' });
    const result = await tool.execute('call-1', {
      state,
      questions: { route: { type: 'choice', instructions: 'Choose', criteria: { inspect: 'Inspect metadata only.', needs_human: 'Cannot classify safely.' } } },
    } as never, new AbortController().signal);
    expect(JSON.stringify(result)).not.toContain('DECISION_SECRET_FIELD');
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['credential value', { credentialValue: 'must-not-send' }],
    ['credential json', { credential_json: { refresh_token: 'must-not-send' } }],
    ['secret env name', { OPENAI_API_KEY: 'must-not-send' }],
  ])('rejects %s', async (_label, state) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const tool = createDecisionEvaluateTool({ userId: 1, projectId: 'project-1', sessionId: 'session-1' });
    const result = await tool.execute('call-1', {
      state,
      questions: { route: { type: 'choice', instructions: 'Choose', criteria: { yes: 'yes', no: 'no' } } },
    } as never, new AbortController().signal);
    expect(JSON.stringify(result)).toContain('DECISION_SECRET_FIELD');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('decision request file boundary', () => {
  it('fails closed on unauthorized file reads before Gateway resolution', async () => {
    vi.mocked(resolveProjectWorkspaceFile).mockRejectedValueOnce(new Error('denied'));
    const tool = createDecisionEvaluateTool({ userId: 1, projectId: 'p', sessionId: 's' });
    const out = await tool.execute('c', { requestPath: '../outside.json' } as never, new AbortController().signal);
    expect(JSON.stringify(out)).toContain('DECISION_REQUEST_FILE_INVALID');
    expect(resolveGatewayProfileClient).not.toHaveBeenCalled();
  });
  it('checks secret fields in loaded JSON before provider access', async () => {
    vi.mocked(resolveProjectWorkspaceFile).mockResolvedValueOnce({} as never);
    vi.mocked(readProjectWorkspaceFileBytes).mockResolvedValueOnce({ storageKind: 'host', bytes: Buffer.from(JSON.stringify({ state: { password: 'fixture' }, questions: {} })) });
    const tool = createDecisionEvaluateTool({ userId: 1, projectId: 'p', sessionId: 's' });
    const out = await tool.execute('c', { requestPath: 'request.json' } as never, new AbortController().signal);
    expect(JSON.stringify(out)).toContain('DECISION_SECRET_FIELD');
    expect(readProjectWorkspaceFileBytes).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 1, maxBytes: 150_000 }));
    expect(resolveGatewayProfileClient).not.toHaveBeenCalled();
  });
});

 it('reads the exact Project request bytes and returns their hash through the existing Gateway', async () => {
   const bytes = Buffer.from(JSON.stringify({ state: { task: 'fixture' }, questions: { route: { type: 'choice', instructions: 'Choose', criteria: { yes: 'yes', no: 'no' } } }, timeoutMs: 2000 }));
   vi.mocked(resolveProjectWorkspaceFile).mockResolvedValueOnce({ projectId: 'p', relativePath: 'request.json' } as never);
   vi.mocked(readProjectWorkspaceFileBytes).mockResolvedValueOnce({ storageKind: 'host', bytes });
   vi.mocked(resolveGatewayProfileClient).mockResolvedValue({ profileId: 'fixture', baseUrl: 'https://gateway.example.com', credentialId: 'fixture', apiKey: 'fixture' } as never);
   const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ answers: { route: { type: 'choice', choice: 'yes', probabilities: { yes: 1, no: 0 }, confidence: 1 } } }), { status: 200 }));
   const tool = createDecisionEvaluateTool({ userId: 1, projectId: 'p', sessionId: 's' });
   const out = await tool.execute('c', { requestPath: 'request.json' } as never, new AbortController().signal);
   expect(JSON.parse((out as any).content[0].text)).toMatchObject({ requestEvidence: { requestPath: 'request.json', sha256: crypto.createHash('sha256').update(bytes).digest('hex') } });
   expect(resolveGatewayProfileClient).toHaveBeenCalledWith({ actorUserId: 1, projectId: 'p' });
   expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).state).toEqual({ task: 'fixture' });
 });
