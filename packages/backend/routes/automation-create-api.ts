import { Router } from 'express';
import { authMiddleware } from '../services/auth/auth.js';
import { activateAutomationCreation, AutomationPlanError, previewAutomationCreation } from '../services/task/automation-create-plan.js';

const router = Router();
router.use(authMiddleware);
router.post('/', async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.userId) return res.status(401).json({ error: 'unauthorized' });
    res.json(await previewAutomationCreation(req.body, { userId: user.userId, role: user.role }));
  } catch (error) {
    res.status(error instanceof AutomationPlanError ? error.status : 500).json({ error: error instanceof AutomationPlanError ? error.message : '계획 검증에 실패했습니다.' });
  }
});
router.post('/:id/activate', async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.userId) return res.status(401).json({ error: 'unauthorized' });
    if (!req.body || Object.keys(req.body).some(k => !['proposalHash','confirmed'].includes(k))) return res.status(400).json({ error: 'invalid activation payload' });
    res.json(await activateAutomationCreation(String(req.params.id), req.body.proposalHash, { userId: user.userId, role: user.role }, req.body.confirmed === true));
  } catch (error) {
    res.status(error instanceof AutomationPlanError ? error.status : 500).json({ error: error instanceof AutomationPlanError ? error.message : '계획 활성화에 실패했습니다.' });
  }
});
export default router;
