import { Router } from 'express';
import { z } from 'zod';
import { getSessionWelcome, normalizeWelcomeLocale, WelcomeAccessError } from '../services/welcome/session-welcome.js';

const router = Router();
const requestSchema = z.object({
  projectId: z.uuid(), sessionId: z.uuid(),
  locale: z.string().regex(/^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8})?$/).max(20),
}).strict();

router.post('/', async (req, res) => {
  // Registered behind /api authentication; keep the closure identity check explicit.
  const { userId, role } = (req as any).user || {};
  if (!Number.isInteger(userId) || userId < 1 || typeof role !== 'string') return res.status(401).json({ error: 'Unauthorized' });
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid welcome request' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    const welcome = await getSessionWelcome({ userId, role, ...parsed.data, locale: normalizeWelcomeLocale(parsed.data.locale) });
    return res.json(welcome);
  } catch (error) {
    if (error instanceof WelcomeAccessError) return res.status(error.status).json({ error: error.message });
    // Authorization/storage failures must never be disguised as permission to read cached data.
    return res.status(503).json({ error: 'Welcome unavailable' });
  }
});

export default router;
