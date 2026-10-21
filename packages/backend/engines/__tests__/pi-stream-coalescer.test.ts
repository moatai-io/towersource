import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantStreamCoalescer } from '../pi/stream-coalescer.js';
import type { TowerContentBlock } from '../types.js';

function text(value: string): TowerContentBlock[] {
  return [{ type: 'text', text: value }];
}

describe('AssistantStreamCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes immediate assistant events and increments counters', () => {
    const events: any[] = [];
    const coalescer = new AssistantStreamCoalescer({
      sessionId: 's1',
      getMsgId: () => 'm1',
      streamFlushMs: 150,
      dbFlushMs: 300,
      pushAssistantEvent: (message) => events.push(message),
      trackDbWrite: () => {},
      updateMessageContent: () => {},
    });

    coalescer.queueAssistantEvent(text('hello'), true);

    expect(events).toEqual([{ type: 'assistant', sessionId: 's1', msgId: 'm1', content: text('hello'), timestamp: 0 }]);
    expect(coalescer.perf.assistantSnapshotsQueued).toBe(1);
    expect(coalescer.perf.assistantSnapshotsFlushed).toBe(1);
  });

  it('coalesces delayed assistant events and flushes only the latest content', () => {
    const events: any[] = [];
    const coalescer = new AssistantStreamCoalescer({
      sessionId: 's1',
      getMsgId: () => 'm1',
      streamFlushMs: 150,
      dbFlushMs: 300,
      pushAssistantEvent: (message) => events.push(message),
      trackDbWrite: () => {},
      updateMessageContent: () => {},
    });

    coalescer.queueAssistantEvent(text('initial'));
    events.length = 0;
    coalescer.queueAssistantEvent(text('first'));
    coalescer.queueAssistantEvent(text('second'));
    expect(events).toHaveLength(0);

    vi.advanceTimersByTime(150);

    expect(events).toHaveLength(1);
    expect(events[0].content).toEqual(text('second'));
    expect(coalescer.perf.assistantSnapshotsQueued).toBe(3);
    expect(coalescer.perf.assistantSnapshotsFlushed).toBe(2);
  });

  it('flushes the first answer immediately after progress, including a new message', () => {
    const events: any[] = [];
    let msgId = 'm1';
    const coalescer = new AssistantStreamCoalescer({ sessionId: 's1', getMsgId: () => msgId,
      streamFlushMs: 150, dbFlushMs: 300, pushAssistantEvent: (m) => events.push(m),
      trackDbWrite: () => {}, updateMessageContent: () => {} });
    coalescer.queueAssistantEvent([{ type: 'tool_use', id: 't', name: 'read', input: {} }], true);
    coalescer.queueAssistantEvent(text('hello'));
    expect(events).toHaveLength(2);
    coalescer.queueAssistantEvent(text('hello world'));
    expect(events).toHaveLength(2);
    coalescer.flushAssistantEvent();
    msgId = 'm2';
    coalescer.queueAssistantEvent(text('next'));
    expect(events.at(-1)).toMatchObject({ msgId: 'm2', content: text('next') });
    vi.advanceTimersByTime(150);
    expect(events).toHaveLength(4);
  });

  it('coalesces DB updates and tracks the latest pending write', () => {
    const dbWrites: any[] = [];
    const coalescer = new AssistantStreamCoalescer({
      sessionId: 's1',
      getMsgId: () => 'm1',
      streamFlushMs: 150,
      dbFlushMs: 300,
      pushAssistantEvent: () => {},
      trackDbWrite: (op) => { dbWrites.push(op); },
      updateMessageContent: (id, content) => ({ id, content }),
    });

    coalescer.queueAssistantDbUpdate('m1', text('old'));
    coalescer.queueAssistantDbUpdate('m1', text('new'));

    expect(coalescer.getPendingAssistantDbUpdate()).toEqual({ msgId: 'm1', content: text('new') });
    expect(dbWrites).toHaveLength(0);

    vi.advanceTimersByTime(300);

    expect(dbWrites).toEqual([{ id: 'm1', content: text('new') }]);
    expect(coalescer.getPendingAssistantDbUpdate()).toBeNull();
    expect(coalescer.perf.assistantDbUpdatesQueued).toBe(2);
    expect(coalescer.perf.assistantDbUpdatesFlushed).toBe(1);
  });

  it('clears timers and pending state without flushing after reset', () => {
    const events: any[] = [];
    const dbWrites: any[] = [];
    const coalescer = new AssistantStreamCoalescer({
      sessionId: 's1',
      getMsgId: () => 'm1',
      streamFlushMs: 150,
      dbFlushMs: 300,
      pushAssistantEvent: (message) => events.push(message),
      trackDbWrite: (op) => { dbWrites.push(op); },
      updateMessageContent: (id, content) => ({ id, content }),
    });

    coalescer.queueAssistantEvent(text('initial'));
    events.length = 0;
    coalescer.queueAssistantEvent(text('pending'));
    coalescer.queueAssistantDbUpdate('m1', text('pending'));
    coalescer.clearAllTimers();
    coalescer.resetPending();
    vi.advanceTimersByTime(1_000);

    expect(events).toHaveLength(0);
    expect(dbWrites).toHaveLength(0);
  });
});
