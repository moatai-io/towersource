import { describe, expect, it } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { PdfObservationState } from './pdf-observation-state.js';
import { stripPdfObservationText } from './pdf-observation-visibility.js';
const id = 'b'.repeat(24);
const pdf = { role: 'toolResult', toolName: 'pdf_view', toolCallId: 't', isError: false, timestamp: Date.now(),
  details: { visualReference: { version: 1, batchId: id, source: 'session://attachments/test', sourceVersion: 'v1', pages: [39, 40], dpi: 144 } },
  content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] };
const model: any = { id: 'test', name: 'test', provider: 'test', api: 'openai-responses', baseUrl: 'https://example.invalid', reasoning: false,
  input: ['text', 'image'], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

describe('native Agent finishTurn/prepareNextTurn PDF checkpoint loop', () => {
  it.each([false, true])('fills final receipt through native scheduling; compliant=%s', async compliant => {
    let requests = 0; const state = new PdfObservationState();
    const agent = new Agent({ initialState: { model, messages: [{ role: 'user', content: 'Read PDF', timestamp: Date.now() }, pdf] as any },
      finishTurn: state.finishTurn, prepareNextTurn: state.prepareNextTurn as any,
      streamFn: () => {
        requests++; const stream = createAssistantMessageEventStream();
        const text = requests === 1 ? 'All pages read.' : compliant
          ? `[PDF observation batch=${id}] Pages 39 and 40 contain the ending table; labels need requery. [/PDF observation] Final verified answer.`
          : 'All pages read again.';
        const message: any = { role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id,
          stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } };
        queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); }); return stream;
      } });
    await agent.continue();
    expect(requests).toBe(compliant ? 2 : 3);
    expect(state.completionIncomplete).toBe(!compliant);
    const custom = agent.state.messages.filter((m: any) => m.role === 'custom');
    expect(custom).toHaveLength(compliant ? 1 : 2);
    expect((custom[0] as any).display).toBe(false);
    if (compliant) {
      expect(state.has(pdf.details.visualReference as any)).toBe(true);
      const last: any = agent.state.messages.at(-1);
      expect(stripPdfObservationText(last.content[0].text).trim()).toBe('Final verified answer.');
    }
  });
});
