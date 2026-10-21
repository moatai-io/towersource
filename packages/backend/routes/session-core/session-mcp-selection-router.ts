/** Pi conversation MCP surface opt-outs. Agent authorization remains loader-owned. */
import { Router } from 'express';
import { getSession } from '../../services/session/session-manager.js';
import { canAccessSession, canSendSessionMessage } from '../../services/pm/project-access.js';
import { getSessionMcpSelection, setSessionMcpSelection } from '../../services/session/session-mcp-selection.js';
import { isMcpServerExclusionList } from '../../../shared/session-mcp-selection.js';

const router = Router();

router.get('/sessions/:id/mcp-selection', async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.userId) { res.status(401).json({ error: 'Authentication required' }); return; }
    const access = await canAccessSession(req.params.id as string, user.userId, user.role);
    if (!access.allowed) { res.status(access.status).json({ error: access.message }); return; }
    const selection = await getSessionMcpSelection(req.params.id as string);
    if (!selection) { res.status(404).json({ error: 'Session not found' }); return; }
    res.json(selection);
  } catch (error) {
    console.error('[session-mcp-selection] read failed:', error instanceof Error ? error.message : 'unknown');
    res.status(500).json({ error: 'Failed to read MCP selection' });
  }
});

router.patch('/sessions/:id/mcp-selection', async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.userId) { res.status(401).json({ error: 'Authentication required' }); return; }
    // Pin the project before ACL checks; the UPDATE compares this identity again.
    const session = await getSession(req.params.id as string);
    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
    const readAccess = await canAccessSession(req.params.id as string, user.userId, user.role);
    if (!readAccess.allowed) { res.status(readAccess.status).json({ error: readAccess.message }); return; }
    const access = await canSendSessionMessage(req.params.id as string, user.userId, user.role);
    if (!access.allowed) { res.status(access.status).json({ error: access.message }); return; }
    if (session.engine !== 'pi') {
      res.status(409).json({ error: 'MCP conversation selection is only available for Pi sessions' }); return;
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => key !== 'excludedServerNames' && key !== 'projectId')
      || !isMcpServerExclusionList(body.excludedServerNames)
      || ('projectId' in body && body.projectId !== null && typeof body.projectId !== 'string')) {
      res.status(400).json({ error: 'Expected excludedServerNames: string[] and optional projectId' }); return;
    }
    const projectId = session.projectId ?? null;
    if ('projectId' in body && body.projectId !== projectId) {
      res.status(409).json({ error: 'Session project changed; reload selection' }); return;
    }
    const selection = await setSessionMcpSelection(session.id, projectId, body.excludedServerNames);
    if (!selection) { res.status(409).json({ error: 'Session project changed; reload selection' }); return; }
    res.json(selection);
  } catch (error) {
    console.error('[session-mcp-selection] update failed:', error instanceof Error ? error.message : 'unknown');
    res.status(500).json({ error: 'Failed to update MCP selection' });
  }
});

export default router;
