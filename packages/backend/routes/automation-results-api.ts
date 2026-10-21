import { Router } from 'express';
import { AutomationResultsAccessError, listAutomationResults } from '../services/task/automation-results.js';
import { acknowledgeAutomationResult, AutomationReceiptError } from '../services/task/automation-result-receipts.js';

const router = Router();

// Read and action receipts are personal acknowledgements, not run status mutations.
router.post('/:runId/receipt', async (req, res) => {
  const userId = (req as any).user?.userId;
  const role = (req as any).user?.role;
  if (!Number.isInteger(userId) || userId < 1 || typeof role !== 'string') return res.status(401).json({ error: 'unauthorized' });
  const { projectId, action } = req.body || {};
  if (Object.keys(req.body || {}).some(key => !['projectId', 'action'].includes(key))
    || typeof projectId !== 'string' || !projectId.trim() || projectId.length > 200 || projectId !== projectId.trim()
    || !['read', 'actioned'].includes(action) || !/^[A-Za-z0-9_-]{1,120}$/.test(req.params.runId)) {
    return res.status(400).json({ error: 'invalid result receipt request' });
  }
  try {
    const receipt = await acknowledgeAutomationResult({ userId, role, projectId, runId: req.params.runId, action });
    return res.json({ receipt });
  } catch (error) {
    if (error instanceof AutomationReceiptError) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: 'receipt update failed' });
  }
});

// Mount behind api.ts authMiddleware at /automations/results (effective /api/automations/results).
router.get('/', async (req, res) => {
  const userId = (req as any).user?.userId;
  const role = (req as any).user?.role;
  if (!Number.isInteger(userId) || userId < 1 || typeof role !== 'string') {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (Object.keys(req.query).some(key => !['projectId', 'limit'].includes(key))) {
    return res.status(400).json({ error: 'unknown query parameter' });
  }
  const { projectId, limit: rawLimit } = req.query;
  if (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 200 || projectId !== projectId.trim()) {
    return res.status(400).json({ error: 'projectId required' });
  }
  if (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^[1-9]\d*$/.test(rawLimit)
    || Number(rawLimit) > 100)) {
    return res.status(400).json({ error: 'limit must be between 1 and 100' });
  }
  try {
    return res.json(await listAutomationResults({
      userId, role, projectId, limit: rawLimit === undefined ? 20 : Number(rawLimit),
    }));
  } catch (error) {
    if (error instanceof AutomationResultsAccessError) {
      return res.status(error.status).json({ error: error.message });
    }
    // Do not leak SQL, filesystem paths or run content through read errors.
    return res.status(500).json({ error: 'Automation results unavailable' });
  }
});

export default router;
