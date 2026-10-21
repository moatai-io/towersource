/** Own-session archive (legacy trash URL retained). Restoring a worker must not silently resume its lifecycle. */
import { Router } from 'express';
import { getArchivedSessions, getSession, restoreSession } from '../../services/session/session-manager.js';
import { canAccessSession, canDeleteSession } from '../../services/pm/project-access.js';
import { queryOne } from '../../db/pg-repo.js';
import { broadcastToUser } from '../ws-handler.js';

const router = Router();
router.get(['/sessions/archived', '/sessions/trash'], async (req, res) => {
  const { userId, role } = (req as any).user || {};
  if (!userId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const sessions = await getArchivedSessions(userId, role);
    const visible = await Promise.all(sessions.map(async session =>
      (await canAccessSession(session.id, userId, role)).allowed ? session : null));
    res.json(visible.filter(Boolean));
  } catch { res.status(500).json({ error: 'Could not load archive' }); }
});
router.post('/sessions/:id/restore', async (req, res) => {
  const { userId, role } = (req as any).user || {};
  if (!userId) return res.status(401).json({ error: 'Authentication required' });
  const id = req.params.id as string;
  try {
    const row = await queryOne<{ user_id: number; archived: number }>(
      'SELECT user_id, archived FROM sessions WHERE id = $1', [id]);
    if (!row) return res.status(404).json({ error: 'Session not found' });
    if (row.user_id !== userId) return res.status(403).json({ error: 'Only your own sessions can be unarchived' });
    for (const access of [await canAccessSession(id, userId, role), await canDeleteSession(id, userId, role)]) {
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }
    const worker = await queryOne('SELECT id FROM agent_workers WHERE backing_session_id = $1 LIMIT 1', [id]);
    if (worker) return res.status(409).json({ error: 'worker_lifecycle_restore_required' });
    if (row.archived && !(await restoreSession(id))) return res.status(404).json({ error: 'Session not found' });
    const session = await getSession(id, userId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    broadcastToUser(userId, { type: 'session_created', session });
    res.json({ session });
  } catch { res.status(500).json({ error: 'Could not restore session' }); }
});
export default router;
