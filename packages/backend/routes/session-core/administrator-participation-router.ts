import { Router } from 'express';
import { queryOne } from '../../db/pg-repo.js';
import { canAccessRoom } from '../../services/pm/project-access.js';
import { isProjectMember } from '../../services/pm/project-membership-manager.js';
import { changeAdministratorParticipation, listAdministratorParticipants, ParticipationError, type ParticipationScope } from '../../services/pm/administrator-participation.js';

const router = Router();
router.all('/administrator-participation/:scope/:targetId', async (req, res) => {
  const userId = (req as any).user?.userId;
  const scope = req.params.scope as ParticipationScope;
  const targetId = req.params.targetId;
  if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(401).json({ error: 'Authentication required' });
  if (!['project', 'channel'].includes(scope) || typeof targetId !== 'string' || !targetId.trim() || targetId.length > 200) {
    return res.status(400).json({ error: 'Valid project/channel scope and targetId required' });
  }
  try {
    const actor = await queryOne<{ role: string; disabled: number }>('SELECT role, disabled FROM users WHERE id = $1', [userId]);
    if (!actor || actor.disabled !== 0) return res.status(403).json({ error: 'Active account required' });
    if (req.method === 'GET') {
      const permitted = actor.role === 'admin' || actor.role === 'operator' || (scope === 'project'
        ? await isProjectMember(targetId, userId) : (await canAccessRoom(targetId, userId, actor.role)).allowed);
      if (!permitted) return res.status(403).json({ error: 'Audience access required' });
      return res.json({ scope, targetId, participants: await listAdministratorParticipants(scope, targetId) });
    }
    if (!['POST', 'DELETE'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    if (req.body?.confirmed !== true) return res.status(400).json({ error: 'Explicit confirmation required' });
    const result = await changeAdministratorParticipation({ scope, targetId, userId, join: req.method === 'POST' });
    return res.json({ scope, targetId, ...result });
  } catch (error) {
    if (error instanceof ParticipationError) return res.status(error.status).json({ error: error.message });
    return res.status(503).json({ error: 'Administrator participation could not be persisted safely' });
  }
});
export default router;
