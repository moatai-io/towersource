import { describe, expect, it } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { ImmediateSteering } from './immediate-steering.js';

// Real installed SDK loop with a deterministic provider stream: no network or credentials.
describe('immediate steering against installed Pi Agent', () => {
  it('aborts the current stream, consumes queued instructions once and preserves transcript', async () => {
    let started!: () => void;
    const ready = new Promise<void>(r => { started = r; });
    let calls = 0;
    const steering = new ImmediateSteering();
    const model: any = { id: 'fixture', name: 'fixture', api: 'openai-responses', provider: 'openai', contextWindow: 100000, maxTokens: 4096, input: ['text'], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const agent = new Agent({
      initialState: { model },
      streamFn: (_model, context, options) => {
        const stream = createAssistantMessageEventStream();
        const message: any = {
          role: 'assistant', content: [{ type: 'text', text: calls === 0 ? 'old partial' : 'new answer' }],
          api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop', timestamp: Date.now(),
        };
        calls++;
        if (calls === 1) {
          stream.push({ type: 'start', partial: message });
          options?.signal?.addEventListener('abort', () => {
            message.stopReason = 'aborted';
            message.errorMessage = 'aborted';
            stream.push({ type: 'error', reason: 'aborted', error: message });
          }, { once: true });
          started();
        } else {
          expect(context.messages.filter(m => m.role === 'user')).toHaveLength(2);
          stream.push({ type: 'done', reason: 'stop', message });
        }
        return stream;
      },
    });
    const run = steering.run(() => agent.prompt('initial'), () => agent.continue(), () => false);
    await ready;
    agent.steer({ role: 'user', content: [{ type: 'text', text: 'new instruction' }], timestamp: Date.now() });
    steering.request(async () => { agent.abort(); await agent.waitForIdle(); }, () => false);
    await run;
    expect(calls).toBe(2);
    expect(agent.hasQueuedMessages()).toBe(false);
    expect(agent.state.messages.filter(m => m.role === 'user')).toHaveLength(2);
    expect(agent.state.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'stop' });
  });
});
