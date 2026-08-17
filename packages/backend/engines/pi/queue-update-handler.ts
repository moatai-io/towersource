// Owns Pi steering queue_update → Tower steer_delivered conversion.
// Public API: handlePiQueueUpdate.

import type { TowerMessage } from '../types.js';
import { diffConsumedSteers } from '../pi-steer-tracker.js';
import type { PiSessionEntry } from './session-entry.js';

export function handlePiQueueUpdate(params: {
  event: any;
  entry: PiSessionEntry;
  sessionId: string;
}): TowerMessage[] {
  const { event, entry, sessionId } = params;
  const current: string[] = Array.isArray(event.steering) ? event.steering.slice() : [];
  if (entry.suppressSteerDelivery) {
    entry.lastSteering = current;
    return [];
  }

  const prev = entry.lastSteering ?? [];
  const consumed = diffConsumedSteers(prev, current);
  const out: TowerMessage[] = [];

  if (consumed.length > 0 && entry.pendingSteers?.length) {
    const consumedCount = new Map<string, number>();
    for (const text of consumed) consumedCount.set(text, (consumedCount.get(text) ?? 0) + 1);

    const remaining: typeof entry.pendingSteers = [];
    for (const pending of entry.pendingSteers) {
      const count = consumedCount.get(pending.text) ?? 0;
      if (count > 0) {
        consumedCount.set(pending.text, count - 1);
        console.log(`[Pi] steer delivered: session=${sessionId.slice(0, 8)} msgId=${pending.msgId.slice(0, 8)}`);
        out.push({
          type: 'steer_delivered',
          sessionId,
          msgId: pending.msgId,
          text: pending.text,
          username: pending.username,
        });
      } else {
        remaining.push(pending);
      }
    }
    entry.pendingSteers = remaining;
  }

  entry.lastSteering = current;
  return out;
}
