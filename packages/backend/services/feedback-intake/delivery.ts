import type { Delivery, IntakeStore } from './contract.js';
import { DeliveryFailure } from './github-app.js';

export interface DeliverySender { send(delivery: Delivery): Promise<{ issueNumber: number; issueUrl: string }> }
export async function deliverOne(store: IntakeStore, sender: DeliverySender): Promise<boolean> {
  const delivery = await store.claim();
  if (!delivery) return false;
  let result: Awaited<ReturnType<DeliverySender['send']>>;
  try { result = await sender.send(delivery); }
  catch (error) {
    const known = error instanceof DeliveryFailure ? error : new DeliveryFailure('feedback_delivery_unknown', 'review');
    await store.settle(delivery, {
      status: known.disposition === 'review' ? 'needs_review' : known.disposition === 'retry' && delivery.attempts < 5 ? 'accepted' : 'failed',
      code: known.code,
    });
    return true;
  }
  // If persistence fails after create, leave delivering; expired claims go to review.
  // Never feed a failed settlement back into the retry branch.
  await store.settle(delivery, { status: 'delivered', ...result });
  return true;
}
export function startDeliveryPump(store: IntakeStore, sender: DeliverySender, intervalMs = 5000): () => void {
  let active = false;
  let stopped = false;
  const tick = async () => {
    if (active || stopped) return;
    active = true;
    try { await deliverOne(store, sender); }
    catch { console.warn('[feedback-intake] delivery_tick_failed'); }
    finally { active = false; }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
  void tick();
  // In-flight send can finish. Abrupt shutdown is conservatively recovered as needs_review.
  return () => { stopped = true; clearInterval(timer); };
}
