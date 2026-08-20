import { describe, expect, it, vi } from 'vitest';
import { assertRuntimeBoxAgentProvider, createBackendAIServiceAgentRuntimeProvider } from './ai-service-agent-runtime-provider.js';

describe('AI Service agent runtime provider contract', () => {
  it('reports the current backend execution boundary honestly', async () => {
    const run = vi.fn(() => (async function* () { yield { type: 'engine_done', sessionId: 's1' } as any; })());
    const provider = createBackendAIServiceAgentRuntimeProvider();
    const events = [];
    for await (const event of provider.run({ engine: { run } as any, sessionId: 's1', prompt: 'hello', opts: {} as any, callbacks: {} as any })) events.push(event);
    expect(provider).toMatchObject({ kind: 'backend-engine', executionBoundary: 'backend-process' });
    expect(run).toHaveBeenCalledWith('s1', 'hello', {}, {});
    expect(events).toHaveLength(1);
  });

  it('fails closed when full Runtime Box agent-loop isolation is required but unavailable', () => {
    expect(() => assertRuntimeBoxAgentProvider(createBackendAIServiceAgentRuntimeProvider()))
      .toThrow('Runtime Box agent provider required; selected=backend-engine/backend-process');
  });
});
