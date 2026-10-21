import express, { Router, type ErrorRequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import type { Pool } from 'pg';
import { webhookPayloadHash, type WebhookIngressBinding } from './contract.js';
import { WebhookEventStore } from './store.js';

/** Public Webhook Ingress: verify, normalize, durably enqueue, and acknowledge only. */
export function createWebhookIngressRouter(pool: Pool, resolveBinding: (provider: string, connectorId: string) => WebhookIngressBinding | null): Router {
  const router = Router();
  const store = new WebhookEventStore(pool);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'webhook_rate_limited' } }));
  router.use(express.raw({ type: 'application/json', limit: '256kb' }));
  router.post('/:provider/:connectorId', async (req, res) => {
    const binding = resolveBinding(req.params.provider, req.params.connectorId);
    if (!binding || binding.verifier.provider !== req.params.provider) {
      res.status(404).json({ error: 'webhook_connector_not_found' }); return;
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const verified = binding.verifier.verify({ request: req, rawBody: raw });
    if (!verified.ok) { res.status(verified.status).json({ error: verified.error }); return; }
    try {
      const admitted = await store.admit({ connectorId: binding.connectorId, event: verified.event,
        payloadHash: webhookPayloadHash(raw) });
      if (admitted.conflict) { res.status(409).json({ error: 'webhook_idempotency_conflict' }); return; }
      res.status(admitted.duplicate ? 200 : 202).json({ status: admitted.receipt.status,
        duplicate: admitted.duplicate, eventId: admitted.receipt.id });
    } catch {
      // Provider retries on 5xx. No Agent execution or Provider API read happens here.
      res.status(503).json({ error: 'webhook_admission_unavailable' });
    }
  });
  router.use(((_error, _req, res, _next) => { res.status(400).json({ error: 'webhook_invalid_or_oversized_json' }); }) as ErrorRequestHandler);
  return router;
}
