import { scheduledExecutionEnabled } from '../task/scheduler-ownership.js';
import { secretariatStore } from './store.js';
import { secretariatService } from './service.js';

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
export async function tickSecretariat(): Promise<void> {
  if (!scheduledExecutionEnabled() || running) return;
  running = true;
  try {
    // Durable per-user atomic claim is independent of the Automation scheduler advisory lock.
    for (const userId of await secretariatStore.dueUsers()) {
      if (!timer || !scheduledExecutionEnabled()) break;
      await secretariatService.runUser(userId);
    }
  } catch { /* Missing migration/configuration: fail closed, no model or external notification. */ }
  finally { running = false; }
}
export function startSecretariatScheduler(): void {
  if (timer || !scheduledExecutionEnabled()) return;
  timer = setInterval(() => { void tickSecretariat(); }, TICK_MS);
  timer.unref();
}
export function stopSecretariatScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
