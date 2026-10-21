/** Owns session-aware present_file delivery state for one browser tab. */

export interface SessionViewerDelivery {
  deliveryId: string;
  sessionId: string;
  path: string;
  label?: string;
  focus: boolean;
  reveal?: boolean;
}

const pendingBySession = new Map<string, SessionViewerDelivery>();
const consumedDeliveryIds = new Set<string>();

/** Queue the latest Viewer delivery for an inactive session without changing the active screen. */
export function queueSessionViewerDelivery(delivery: SessionViewerDelivery): void {
  if (consumedDeliveryIds.has(delivery.deliveryId)) return;
  pendingBySession.set(delivery.sessionId, delivery);
}

/** Consume a delivery exactly once when its session becomes active. */
export function consumeSessionViewerDelivery(sessionId: string): SessionViewerDelivery | null {
  const delivery = pendingBySession.get(sessionId);
  if (!delivery || consumedDeliveryIds.has(delivery.deliveryId)) return null;
  pendingBySession.delete(sessionId);
  consumedDeliveryIds.add(delivery.deliveryId);
  return delivery;
}

/** Mark a live active-session delivery consumed so transcript replay cannot reopen it. */
export function markSessionViewerDeliveryConsumed(deliveryId: string): void {
  consumedDeliveryIds.add(deliveryId);
  for (const [sessionId, delivery] of pendingBySession) {
    if (delivery.deliveryId === deliveryId) pendingBySession.delete(sessionId);
  }
}

/** Whether this browser tab already handled the delivery. */
export function hasConsumedSessionViewerDelivery(deliveryId: string): boolean {
  return consumedDeliveryIds.has(deliveryId);
}

/** Test/reset hook; browser reload intentionally starts a fresh delivery lifetime. */
export function clearSessionViewerDeliveries(): void {
  pendingBySession.clear();
  consumedDeliveryIds.clear();
}
