import express, { Router, type ErrorRequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { assertNoSecrets, FeedbackError, keySchema, safeCode, submissionSchema, tokenDigest, tokenSchema, type IntakeStore, type Tenant } from './contract.js';

/** Must be mounted before the global (10 MB) JSON parser and general browser auth. */
export function createFeedbackRouter(store: IntakeStore): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'feedback_rate_limited' },
  }));
  router.use(async (req, res, next) => {
    const authorization = req.get('authorization') ?? '';
    const parsed = tokenSchema.safeParse(authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
    if (!parsed.success) { res.status(401).json({ error: 'feedback_unauthorized' }); return; }
    try {
      const tenant = await store.authenticate(tokenDigest(parsed.data));
      if (!tenant) { res.status(401).json({ error: 'feedback_unauthorized' }); return; }
      res.locals.feedbackTenant = tenant;
      next();
    } catch { res.status(503).json({ error: 'feedback_unavailable' }); }
  });
  router.use(express.json({ limit: '64kb', strict: true }));
  router.post('/', async (req, res) => {
    try {
      const key = keySchema.parse(req.get('idempotency-key'));
      const payload = submissionSchema.parse(req.body);
      assertNoSecrets(payload);
      const result = await store.accept(res.locals.feedbackTenant as Tenant, key, payload);
      res.status(result.status === 'delivered' ? 200 : 202).json(result);
    } catch (error) {
      res.status(error instanceof z.ZodError ? 400 : error instanceof FeedbackError ? error.httpStatus : 503)
        .json({ error: error instanceof z.ZodError ? 'feedback_invalid_request' : safeCode(error) });
    }
  });
  router.get('/:id', async (req, res) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const userId = z.coerce.number().int().positive().safe().parse(req.get('x-feedback-reporter-id'));
      const result = await store.status((res.locals.feedbackTenant as Tenant).id, id, userId);
      if (!result) { res.status(404).json({ error: 'feedback_not_found' }); return; }
      res.json(result);
    } catch (error) {
      res.status(error instanceof z.ZodError ? 400 : 503).json({ error: 'feedback_status_unavailable' });
    }
  });
  router.use(((_error, _req, res, _next) => {
    res.status(400).json({ error: 'feedback_invalid_or_oversized_json' });
  }) as ErrorRequestHandler);
  return router;
}
