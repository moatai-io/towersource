import { Router, type Response } from 'express';
import { authMiddleware } from '../services/auth/auth.js';
import { getVisualTeams, patchVisualTeams, VisualTeamsError, visualTeamsPatchSchema } from '../services/agent-workspaces/visual-teams.js';

const router = Router();
router.use(authMiddleware);
function actorId(req: any): number | null {
  const id = req.user?.userId;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function fail(res: Response, error: unknown) {
  return res.status(error instanceof VisualTeamsError ? error.status : 500)
    .json({ error: error instanceof VisualTeamsError ? error.message : 'Visual teams unavailable' });
}
router.get('/', async (req, res) => {
  const id = actorId(req);
  if (!id) return res.status(401).json({ error: 'Authentication required' });
  try { return res.json(await getVisualTeams(id)); }
  catch (error) { return fail(res, error); }
});
router.patch('/', async (req, res) => {
  const id = actorId(req);
  if (!id) return res.status(401).json({ error: 'Authentication required' });
  const parsed = visualTeamsPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid visual team command' });
  try { return res.json(await patchVisualTeams(id, parsed.data)); }
  catch (error) { return fail(res, error); }
});
export default router;
