import { afterEach, describe, it, expect, vi } from 'vitest';
import { createPiVisualContextTransform, PI_FRESH_TOOL_TEXT_BYTES, PI_HISTORICAL_TOOL_TEXT_BYTES, PI_HISTORICAL_TOOL_TEXT_TOTAL_BYTES } from './visual-context-lifecycle.js';
afterEach(() => vi.unstubAllEnvs());
describe('native image history and bounded tool text', () => {
  it('retains three parallel images, user images and history across replies and retries', async () => {
    const images = ['a','b','c'].map(id => ({role:'toolResult',toolCallId:id,content:[{type:'image',mimeType:'image/png',data:id}]}));
    const source = [{role:'user',content:[{type:'image',mimeType:'image/png',data:'user'}]}, ...images];
    const transform = createPiVisualContextTransform();
    expect(await transform(source)).toEqual(source);
    const next = [...source,{role:'assistant',content:[{type:'text',text:'compare'}]},{role:'toolResult',toolCallId:'other',content:[{type:'text',text:'ok'}]}];
    expect(await transform(next)).toEqual(next);
    expect(await transform(next)).toEqual(next);
    expect(images[0].content[0].type).toBe('image');
  });
  it('bounds large text results across a long tool loop without altering persisted evidence or assistant calls', async () => {
    const transform = createPiVisualContextTransform();
    const historical = Array.from({ length: 120 }, (_, i) => ({
      role: 'toolResult', toolCallId: `old-${i}`, toolName: 'bash',
      content: [{ type: 'text', text: `old-${i} ${'x '.repeat(16_000)}` }],
    }));
    const assistant = { role: 'assistant', content: [{ type: 'toolCall', id: 'fresh', name: 'bash', arguments: { command: 'inspect' } }] };
    const fresh = { role: 'toolResult', toolCallId: 'fresh', toolName: 'bash', content: [{ type: 'text', text: 'important header\n' + 'z '.repeat(100_000) + '\nimportant footer' }] };
    const original = [...historical, assistant, fresh];
    const prepared = await transform(original);
    expect(Buffer.byteLength(JSON.stringify(prepared), 'utf8')).toBeLessThan(PI_HISTORICAL_TOOL_TEXT_TOTAL_BYTES + PI_FRESH_TOOL_TEXT_BYTES + 60_000);
    expect(prepared[0].content[0].text).toBe('');
    expect(prepared[120]).toBe(assistant);
    expect(prepared[121].content[0].text).toContain('important header');
    expect(prepared[121].content[0].text).toContain('important footer');
    expect(prepared[121].toolCallId).toBe('fresh');
    expect(fresh.content[0].text).toHaveLength(200_000 + 'important header\n\nimportant footer'.length);
    expect(historical[0].content[0].text).toContain('x '.repeat(16_000));
    expect((await transform(original))[121].content[0].text).toBe(prepared[121].content[0].text);
  });

  it('budgets JSON-escaped text and keeps the head and tail of a newline-heavy tool result', async () => {
    const text = 'important first line\n' + 'line "\\value"\n'.repeat(100_000) + 'important final line';
    const tool = { role: 'toolResult', toolCallId: 'lines', content: [{ type: 'text', text }] };
    const [prepared] = await createPiVisualContextTransform()([tool]);
    expect(Buffer.byteLength(JSON.stringify(prepared.content[0].text), 'utf8')).toBeLessThanOrEqual(PI_FRESH_TOOL_TEXT_BYTES);
    expect(prepared.content[0].text).toContain('important first line');
    expect(prepared.content[0].text).toContain('important final line');
    expect(prepared.content[0].text).toContain('fresh tool text shortened for provider request');
    expect(tool.content[0].text).toBe(text);
  });

  it('keeps the latest unanswered tool output across a retry but retires it after assistant reply', async () => {
    const transform = createPiVisualContextTransform();
    const tool = { role: 'toolResult', toolCallId: 'retry', content: [{ type: 'text', text: 'fresh-header\n' + 'line\n'.repeat(50_000) + 'fresh-footer' }] };
    const source = [{ role: 'assistant', content: [{ type: 'toolCall', id: 'retry' }] }, tool];
    const first = await transform(source);
    expect((await transform(source))[1].content[0].text).toBe(first[1].content[0].text);
    const retired = await transform([...source, { role: 'assistant', content: [{ type: 'text', text: 'checked' }] }]);
    expect(Buffer.byteLength(JSON.stringify(retired[1].content[0].text))).toBeLessThanOrEqual(PI_HISTORICAL_TOOL_TEXT_BYTES);
    expect(retired[1].content[0].text).toContain('older tool text shortened for provider request');
  });

  it('removes opaque base64 from tool text even when the total text was under the fresh limit', async () => {
    const text = '<svg href="data:image/png;base64,' + 'A'.repeat(10_000) + '">source</svg>';
    const result = await createPiVisualContextTransform()([{ role: 'toolResult', toolCallId: 'svg', content: [{ type: 'text', text }] }]);
    expect(result[0].content[0].text).toContain('embedded binary omitted');
    expect(result[0].content[0].text).not.toContain('A'.repeat(100));
  });

});
