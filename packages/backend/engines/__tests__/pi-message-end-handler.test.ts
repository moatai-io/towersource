import { describe, expect, it } from 'vitest';
import { analyzePiMessageEndCore } from '../pi/message-end-handler.js';

describe('Pi message_end core analysis', () => {
  it('preserves a previous stop reason when a trailing empty error arrives', () => {
    const result = analyzePiMessageEndCore({
      msg: { role: 'assistant', stopReason: 'error', content: [], errorMessage: 'context exhausted' },
      previousStopReason: 'toolUse',
      accumulatorContent: [{ type: 'tool_use', id: 't', name: 'read', input: {} } as any],
    });

    expect(result.shouldApplyStopReason).toBe(false);
    expect(result.providerErrorText).toBe('context exhausted');
    expect(result.assistantContent?.contentToSave).toEqual([{ type: 'tool_use', id: 't', name: 'read', input: {} }]);
    expect(result.assistantContent?.shouldReplaceAccumulator).toBe(false);
  });

  it('extracts assistant final content and chooses it over accumulator when non-empty', () => {
    const result = analyzePiMessageEndCore({
      msg: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }], usage: { input: 1 } },
      previousStopReason: undefined,
      accumulatorContent: [{ type: 'text', text: 'partial' }],
    });

    expect(result.usage).toEqual({ input: 1 });
    expect(result.msgStopReason).toBe('stop');
    expect(result.msgContentLen).toBe(1);
    expect(result.shouldApplyStopReason).toBe(true);
    expect(result.providerErrorText).toBeUndefined();
    expect(result.assistantContent?.finalContent).toEqual([{ type: 'text', text: 'done' }]);
    expect(result.assistantContent?.contentToSave).toEqual([{ type: 'text', text: 'done' }]);
    expect(result.assistantContent?.shouldReplaceAccumulator).toBe(true);
  });

  it('omits Responses commentary from assistant message_end final payload while preserving tool calls', () => {
    const result = analyzePiMessageEndCore({
      msg: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [
          {
            type: 'text',
            text: 'Need implement design. Only MessageBubble. Need maybe tests adjust "Done" still.',
            textSignature: JSON.stringify({ v: 1, phase: 'commentary' }),
          },
          { type: 'toolCall', id: 't', name: 'read', arguments: { path: 'a.txt' } },
        ],
      },
      previousStopReason: undefined,
      accumulatorContent: [],
    });

    expect(result.assistantContent?.finalContent).toEqual([
      { type: 'tool_use', id: 't', name: 'read', input: { path: 'a.txt', file_path: 'a.txt' } },
    ]);
    expect(result.assistantContent?.contentToSave).toEqual([
      { type: 'tool_use', id: 't', name: 'read', input: { path: 'a.txt', file_path: 'a.txt' } },
    ]);
  });

  it('does not produce assistant content for non-assistant message_end events', () => {
    const result = analyzePiMessageEndCore({
      msg: { role: 'user', stopReason: 'stop', content: [{ type: 'text', text: 'hello' }] },
      accumulatorContent: [],
    });

    expect(result.assistantContent).toBeUndefined();
    expect(result.shouldApplyStopReason).toBe(true);
  });
});
