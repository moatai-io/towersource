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

    coalescer.queueAssistantEvent(text('first'));
    coalescer.queueAssistantEvent(text('second'));
    expect(events).toHaveLength(0);

    vi.advanceTimersByTime(150);

    expect(events).toHaveLength(1);
    expect(events[0].content).toEqual(text('second'));
    expect(coalescer.perf.assistantSnapshotsQueued).toBe(2);
    expect(coalescer.perf.assistantSnapshotsFlushed).toBe(1);
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

    coalescer.queueAssistantEvent(text('pending'));
    coalescer.queueAssistantDbUpdate('m1', text('pending'));
    coalescer.clearAllTimers();
    coalescer.resetPending();
    vi.advanceTimersByTime(1_000);

    expect(events).toHaveLength(0);
    expect(dbWrites).toHaveLength(0);
  });
});
