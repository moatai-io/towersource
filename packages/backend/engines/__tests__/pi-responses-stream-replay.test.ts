import { describe, expect, it } from 'vitest';
import { processResponsesStream } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { ContentAccumulator } from '../pi/message-adapter.js';
import { handlePiMessageUpdate } from '../pi/message-update-handler.js';

describe('installed Responses SDK → Tower replay', () => {
  it.each([true, false])('early final phase=%s preserves visibility boundary', async (early) => {
    const output: any = { role: 'assistant', provider: 'litellm-responses', content: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: {} } };
    const accumulator = new ContentAccumulator();
    const snapshots: Array<{ type: string; content: unknown }> = [];
    const item = { type: 'message', id: 'synthetic-message', phase: 'final_answer',
      content: [{ type: 'output_text', text: '안녕하세요' }] };
    async function* events() {
      yield { type: 'response.output_item.added', output_index: 0,
        item: { ...item, content: [], phase: early ? 'final_answer' : undefined } };
      yield { type: 'response.output_text.delta', output_index: 0, delta: '안녕' };
      yield { type: 'response.output_text.delta', output_index: 0, delta: '하세요' };
      yield { type: 'response.output_item.done', output_index: 0, item };
      yield { type: 'response.completed', response: { status: 'completed', output: [item] } };
    }
    await processResponsesStream(events() as any, output, { push(update: any) {
      const result = handlePiMessageUpdate({ event: { assistantMessageEvent: update }, accumulator });
      snapshots.push({ type: update.type, content: structuredClone(result.content) });
    } } as any, { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as any);
    const deltas = snapshots.filter((s) => s.type === 'text_delta');
    expect(deltas.map((s) => s.content)).toEqual(early
      ? [[{ type: 'text', text: '안녕' }], [{ type: 'text', text: '안녕하세요' }]] : [[], []]);
    expect(snapshots.find((s) => s.type === 'text_end')?.content).toEqual([{ type: 'text', text: '안녕하세요' }]);
  });
});
