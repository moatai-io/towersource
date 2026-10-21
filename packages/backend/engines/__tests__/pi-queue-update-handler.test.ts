import { describe, expect, it } from 'vitest';
import { handlePiQueueUpdate } from '../pi/queue-update-handler.js';
import type { PiSessionEntry } from '../pi/session-entry.js';

function entry(partial: Partial<PiSessionEntry>): PiSessionEntry {
  return {
    session: {} as any,
    isRunning: true,
    ...partial,
  };
}

describe('Pi queue_update handler', () => {
  it('updates last steering without delivery while suppression is active', () => {
    const e = entry({
      suppressSteerDelivery: true,
      lastSteering: ['old'],
      pendingSteers: [{ text: 'old', msgId: 'm1' }],
    });

    const out = handlePiQueueUpdate({ event: { steering: ['new'] }, entry: e, sessionId: 'session-12345678' });

    expect(out).toEqual([]);
    expect(e.lastSteering).toEqual(['new']);
    expect(e.pendingSteers).toEqual([{ text: 'old', msgId: 'm1' }]);
  });

  it('emits steer_delivered for consumed steering texts in send order', () => {
    const e = entry({
      lastSteering: ['a', 'b', 'c'],
      pendingSteers: [
        { text: 'a', msgId: 'm-a', username: 'u1' },
        { text: 'b', msgId: 'm-b', username: 'u2' },
        { text: 'c', msgId: 'm-c', username: 'u3' },
      ],
    });

    const out = handlePiQueueUpdate({ event: { steering: ['c'] }, entry: e, sessionId: 'session-12345678' });

    expect(out).toEqual([
      { type: 'steer_delivered', sessionId: 'session-12345678', msgId: 'm-a', text: 'a', username: 'u1', assistantMsgId: undefined, assistantContent: undefined },
      { type: 'steer_delivered', sessionId: 'session-12345678', msgId: 'm-b', text: 'b', username: 'u2', assistantMsgId: undefined, assistantContent: undefined },
    ]);
    expect(e.pendingSteers).toEqual([{ text: 'c', msgId: 'm-c', username: 'u3' }]);
    expect(e.lastSteering).toEqual(['c']);
  });

  it('handles duplicate steering texts as a multiset', () => {
    const e = entry({
      lastSteering: ['same', 'same'],
      pendingSteers: [
        { text: 'same', msgId: 'm1' },
        { text: 'same', msgId: 'm2' },
      ],
    });

    const out = handlePiQueueUpdate({ event: { steering: ['same'] }, entry: e, sessionId: 's' });

    expect(out).toEqual([{ type: 'steer_delivered', sessionId: 's', msgId: 'm1', text: 'same', username: undefined, assistantMsgId: undefined, assistantContent: undefined }]);
    expect(e.pendingSteers).toEqual([{ text: 'same', msgId: 'm2' }]);
  });

  it('attaches the current assistant checkpoint to the delivery event', () => {
    const e = entry({
      lastSteering: ['redirect'],
      pendingSteers: [{ text: 'redirect', msgId: 'm1' }],
    });

    const out = handlePiQueueUpdate({
      event: { steering: [] },
      entry: e,
      sessionId: 's',
      assistantMsgId: 'a1',
      assistantContent: [{ type: 'text', text: 'answer so far' }],
    });

    expect(out).toEqual([{
      type: 'steer_delivered',
      sessionId: 's',
      msgId: 'm1',
      text: 'redirect',
      username: undefined,
      assistantMsgId: 'a1',
      assistantContent: [{ type: 'text', text: 'answer so far' }],
    }]);
  });

  it('treats missing steering as an empty queue', () => {
    const e = entry({
      lastSteering: ['gone'],
      pendingSteers: [{ text: 'gone', msgId: 'm1' }],
    });

    const out = handlePiQueueUpdate({ event: {}, entry: e, sessionId: 's' });

    expect(out).toEqual([{ type: 'steer_delivered', sessionId: 's', msgId: 'm1', text: 'gone', username: undefined, assistantMsgId: undefined, assistantContent: undefined }]);
    expect(e.lastSteering).toEqual([]);
  });
});
