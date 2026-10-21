import { Router } from 'express';
import { getPgPool } from '../../db/pg.js';
import { deliveryEnabled, githubConfig, intakeEnabled } from './config.js';
import { PgIntakeStore } from './store.js';
import { createFeedbackRouter } from './router.js';
import { startDeliveryPump } from './delivery.js';
import { GitHubAppDelivery } from './github-app.js';

let stopPump: (() => void) | undefined;
export function feedbackIntakeRouter(): Router {
  if (!intakeEnabled() || process.env.TOWER_CANDIDATE_PASSIVE_MODE === 'true') {
    // Reserve the route; do not accidentally fall through to the frontend on disabled VMs.
    return Router().use((_req, res) => { res.status(404).json({ error: 'feedback_disabled' }); });
  }
  return createFeedbackRouter(new PgIntakeStore(getPgPool()));
}
export function startFeedbackDelivery(): void {
  if (!deliveryEnabled() || stopPump) return;
  try { stopPump = startDeliveryPump(new PgIntakeStore(getPgPool()), new GitHubAppDelivery(githubConfig())); }
  catch { console.warn('[feedback-intake] delivery_not_configured'); }
}
export function stopFeedbackDelivery(): void { stopPump?.(); stopPump = undefined; }
