// Owns coalescing of high-frequency Pi assistant stream snapshots for UI and DB.
// Public API: AssistantStreamCoalescer.

import type { TowerContentBlock, TowerMessage } from '../types.js';

type PendingAssistantMsg = Extract<TowerMessage, { type: 'assistant' }>;

export interface AssistantStreamCoalescerPerf {
  rawMessageUpdates: number;
  assistantSnapshotsQueued: number;
  assistantSnapshotsFlushed: number;
  assistantDbUpdatesQueued: number;
  assistantDbUpdatesFlushed: number;
}

export class AssistantStreamCoalescer {
  private pendingAssistantEvent: PendingAssistantMsg | null = null;
  private assistantEventTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAssistantEventFlushAt = 0;
  private pendingAssistantDbUpdate: { msgId: string; content: TowerContentBlock[] } | null = null;
  private assistantDbTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAssistantDbFlushAt = 0;

  readonly perf: AssistantStreamCoalescerPerf = {
    rawMessageUpdates: 0,
    assistantSnapshotsQueued: 0,
    assistantSnapshotsFlushed: 0,
    assistantDbUpdatesQueued: 0,
    assistantDbUpdatesFlushed: 0,
  };

  constructor(private readonly deps: {
    sessionId: string;
    getMsgId: () => string;
    streamFlushMs: number;
    dbFlushMs: number;
    pushAssistantEvent: (message: PendingAssistantMsg) => void;
    trackDbWrite: (op: void | Promise<void>) => void | Promise<void>;
    updateMessageContent: (id: string, content: TowerContentBlock[]) => void | Promise<void>;
  }) {}

  incrementRawMessageUpdates() {
    this.perf.rawMessageUpdates++;
  }

  clearAssistantEventTimer() {
    if (this.assistantEventTimer) clearTimeout(this.assistantEventTimer);
    this.assistantEventTimer = null;
  }

  flushAssistantEvent() {
    if (!this.pendingAssistantEvent) return;
    this.clearAssistantEventTimer();
    this.deps.pushAssistantEvent({ ...this.pendingAssistantEvent, timestamp: Date.now() });
    this.perf.assistantSnapshotsFlushed++;
    this.pendingAssistantEvent = null;
    this.lastAssistantEventFlushAt = Date.now();
  }

  queueAssistantEvent(content: TowerContentBlock[], immediate = false) {
    this.pendingAssistantEvent = {
      type: 'assistant',
      sessionId: this.deps.sessionId,
      msgId: this.deps.getMsgId(),
      content,
      timestamp: Date.now(),
    };
    this.perf.assistantSnapshotsQueued++;
    const elapsed = Date.now() - this.lastAssistantEventFlushAt;
    if (immediate || elapsed >= this.deps.streamFlushMs) {
      this.flushAssistantEvent();
      return;
    }
    if (!this.assistantEventTimer) {
      this.assistantEventTimer = setTimeout(() => this.flushAssistantEvent(), this.deps.streamFlushMs - elapsed);
    }
  }

  clearAssistantDbTimer() {
    if (this.assistantDbTimer) clearTimeout(this.assistantDbTimer);
    this.assistantDbTimer = null;
  }

  flushAssistantDbUpdate() {
    if (!this.pendingAssistantDbUpdate) return;
    this.clearAssistantDbTimer();
    const next = this.pendingAssistantDbUpdate;
    this.pendingAssistantDbUpdate = null;
    this.lastAssistantDbFlushAt = Date.now();
    this.perf.assistantDbUpdatesFlushed++;
    this.deps.trackDbWrite(this.deps.updateMessageContent(next.msgId, next.content));
  }

  queueAssistantDbUpdate(id: string, content: TowerContentBlock[], immediate = false) {
    this.pendingAssistantDbUpdate = { msgId: id, content };
    this.perf.assistantDbUpdatesQueued++;
    const elapsed = Date.now() - this.lastAssistantDbFlushAt;
    if (immediate || elapsed >= this.deps.dbFlushMs) {
      this.flushAssistantDbUpdate();
      return;
    }
    if (!this.assistantDbTimer) {
      this.assistantDbTimer = setTimeout(() => this.flushAssistantDbUpdate(), this.deps.dbFlushMs - elapsed);
    }
  }

  getPendingAssistantDbUpdate(): { msgId: string; content: TowerContentBlock[] } | null {
    return this.pendingAssistantDbUpdate;
  }

  clearPendingAssistantDbUpdate() {
    this.pendingAssistantDbUpdate = null;
  }

  clearAllTimers() {
    this.clearAssistantEventTimer();
    this.clearAssistantDbTimer();
  }

  resetPending() {
    this.pendingAssistantEvent = null;
    this.pendingAssistantDbUpdate = null;
  }
}
