import { describe, expect, it } from 'vitest';
import {
  createPiVisualContextTransform,
  piFreshVisualByteBudget,
  sanitizePiVisualContextForProvider,
} from './visual-context-lifecycle.js';

const image = (data: string) => ({ type: 'image', data, mimeType: 'image/png' });
const toolResult = (id: string, data: string) => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: 'pdf_view',
  content: [{ type: 'text', text: `[PDF ${id}]` }, image(data)],
  timestamp: Date.now(),
});

describe('sanitizePiVisualContextForProvider', () => {
  it('keeps the newest PDF result for immediate vision and omits older rendered pages', () => {
    const first = toolResult('old', 'A'.repeat(4_000_000));
    const latest = toolResult('latest', 'B'.repeat(3_000_000));
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'review pages' }] },
      first,
      { role: 'assistant', content: [{ type: 'text', text: 'checking more pages' }] },
      latest,
    ];

    const sanitized = sanitizePiVisualContextForProvider(messages);
    expect(sanitized).not.toBe(messages);
    expect(sanitized[1].content).toEqual([
      { type: 'text', text: '[PDF old]' },
      { type: 'text', text: expect.stringContaining('previous visual payload omitted') },
    ]);
    expect(sanitized[3]).toBe(latest);
    expect(sanitized[3].content[1].data).toHaveLength(3_000_000);
    expect(first.content[1].data).toHaveLength(4_000_000);
  });

  it('omits all historical visual payloads on a later text-only turn', () => {
    const messages = [
      toolResult('pdf', 'A'.repeat(4_000_000)),
      { role: 'assistant', content: [{ type: 'text', text: 'PDF checked' }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ];

    const sanitized = sanitizePiVisualContextForProvider(messages, 0);
    expect(JSON.stringify(sanitized)).not.toContain('A'.repeat(100));
    expect(JSON.stringify(sanitized)).toContain('previous visual payload omitted');
  });

  it('also removes non-tool historical images while preserving source messages', () => {
    const sourceImage = image('C'.repeat(2_000_000));
    const messages = [{ role: 'user', content: [sourceImage] }];
    const sanitized = sanitizePiVisualContextForProvider(messages);
    expect(sanitized[0].content[0].type).toBe('text');
    expect(messages[0].content[0]).toBe(sourceImage);
  });

  it('exposes a bounded visual tool result to one provider request only', async () => {
    const transform = createPiVisualContextTransform({ maxFreshImageBytes: 1024 });
    const pdf = toolResult('pdf-call', Buffer.alloc(512).toString('base64'));
    const first = await transform([pdf]);
    expect(first[0].content[1].type).toBe('image');

    const later = await transform([pdf, { role: 'assistant', content: [{ type: 'text', text: 'checked' }] }]);
    expect(later[0].content[1].type).toBe('text');
    expect(JSON.stringify(later)).toContain('previous visual payload omitted');
  });

  it('omits an oversized newest visual result before its first provider request', async () => {
    const transform = createPiVisualContextTransform({ maxFreshImageBytes: 1024 });
    const pdf = toolResult('pdf-call', Buffer.alloc(1025).toString('base64'));

    const first = await transform([pdf]);

    expect(first[0].content[1]).toEqual({
      type: 'text',
      text: expect.stringContaining('fresh visual payload omitted by provider context budget'),
    });
    expect(JSON.stringify(first)).not.toContain(pdf.content[1].data.slice(0, 100));
  });

  it('applies the byte budget across every image in the newest tool result', async () => {
    const transform = createPiVisualContextTransform({ maxFreshImageBytes: 1000 });
    const multiPage = {
      ...toolResult('pdf-pages', Buffer.alloc(600).toString('base64')),
      content: [
        { type: 'text', text: '[PDF pages]' },
        image(Buffer.alloc(600).toString('base64')),
        image(Buffer.alloc(600, 1).toString('base64')),
      ],
    };

    const first = await transform([multiPage]);

    expect(first[0].content[1].type).toBe('image');
    expect(first[0].content[2].type).toBe('text');
    expect(first[0].content[2].text).toContain('remaining 400 bytes');
  });

  it('scales the fresh visual budget with the model context window and caps it', () => {
    expect(piFreshVisualByteBudget({ contextWindow: 353_400 })).toBe(512 * 1024);
    expect(piFreshVisualByteBudget({ contextWindow: 760_000 })).toBeGreaterThan(512 * 1024);
    expect(piFreshVisualByteBudget({ contextWindow: 10_000_000 })).toBe(2 * 1024 * 1024);
  });
});
