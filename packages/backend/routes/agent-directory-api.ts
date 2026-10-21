import { Router } from 'express';
import { AgentDirectoryError, agentDirectoryVisibility, listAgentDirectory, listPreviousAgentParticipation } from '../services/pm/agent-directory.js';

const router = Router();
function fail(res: any, error: unknown) {
  return res.status(error instanceof AgentDirectoryError ? error.status : 500)
    .json({ error: error instanceof AgentDirectoryError ? error.message : 'Agent directory unavailable' });
}
function userId(req: any): number | null {
  const id = Number(req.user?.userId);
  return Number.isInteger(id) && id > 0 ? id : null;
}
// Mounted after authMiddleware. The service additionally checks the current account.
router.get('/', async (req, res) => {
  const id = userId(req);
  if (!id) return res.status(401).json({ error: 'Authentication required' });
  try { return res.json({ agents: await listAgentDirectory(id) }); }
  catch (error) { return fail(res, error); }
});
router.get('/previous-participation', async (req, res) => {
  const id = userId(req);
  if (!id) return res.status(401).json({ error: 'Authentication required' });
  try { return res.json({ agents: await listPreviousAgentParticipation(id) }); }
  catch (error) { return fail(res, error); }
});
router.get('/:projectId/visibility', async (req, res) => {
  const id = userId(req);
  if (!id) return res.status(401).json({ error: 'Authentication required' });
  try { return res.json(await agentDirectoryVisibility(id, req.params.projectId)); }
  catch (error) { return fail(res, error); }
});
router.patch('/:projectId/visibility', async (req, res) => {
  const id = userId(req);
  if (!id) return res.status(401).json({ error: 'Authentication required' });
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['visibility', 'confirmed'].includes(key))
    || !['listed', 'unlisted', 'confidential'].includes(body.visibility)
    || body.confirmed !== true) {
    return res.status(400).json({ error: 'An explicit visibility and confirmed: true are required' });
  }
  try { return res.json(await agentDirectoryVisibility(id, req.params.projectId, body.visibility)); }
  catch (error) { return fail(res, error); }
});
export default router;
