import { describe, expect, it } from 'vitest';
import { createTextStreamTiming } from '../pi/text-stream-timing.js';

describe('content-free text stream timing', () => {
  it('distinguishes delayed phase from delayed UI delivery without retaining content', () => {
    let now = 100;
    const timing = createTextStreamTiming(() => now);
    const event = (type: string, phase?: string) => ({ assistantMessageEvent: {
      type, contentIndex: 0, delta: 'DO_NOT_LOG', partial: { content: [{ type: 'text', text: 'DO_NOT_LOG',
        textSignature: phase ? JSON.stringify({ v: 1, phase }) : undefined }] },
    } });
    now = 120; timing.observe(event('text_delta'));
    now = 130; timing.observe(event('text_delta'));
    now = 200; timing.observe(event('text_end', 'final_answer'));
    now = 210; timing.visible();
    now = 220; timing.visible();
    expect(timing.snapshot()).toEqual({ firstDeltaMs: 20, firstUnknownPhaseMs: 20,
      firstTextEndMs: 100, firstFinalPhaseMs: 100, firstVisibleSnapshotMs: 110, deltas: 2, unconfirmedDeltas: 2 });
    expect(JSON.stringify(timing.snapshot())).not.toContain('DO_NOT_LOG');
  });
  it('keeps independent run state and ignores tool and thinking payloads', () => {
    const timing = createTextStreamTiming();
    timing.observe({ assistantMessageEvent: { type: 'thinking_delta', delta: 'private' } });
    expect(timing.snapshot()).toEqual({ deltas: 0, unconfirmedDeltas: 0 });
  });
});
