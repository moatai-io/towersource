/**
 * Owns: authenticated Session listing, creation, lookup, and message reads.
 * Public API: sessionCoreRouter. See README.md.
 */
import { Router } from 'express';
import {
  createSession, getPanelSessions, getSession, getSessionByKey,
  getSessionPanelSessions, getSessions, updateSession,
} from '../../services/session/session-manager.js';
import { getMessages, getMessagesPaginated } from '../../services/message-store.js';
import { canAccessRoom, canAccessSession, canCreateInProject } from '../../services/pm/project-access.js';
import { queryOne } from '../../db/pg-repo.js';
import { broadcastToAll, broadcastToUser } from '../ws-handler.js';

const router = Router();

router.get('/sessions', async (req, res) => {
  const userId = (req as any).user?.userId;
  const role = (req as any).user?.role;
  const roomId = req.query.roomId as string | undefined;
  const parentSessionId = req.query.parentSessionId as string | undefined;
  const projectId = typeof req.query.projectId === 'string' && req.query.projectId.trim() ? req.query.projectId.trim() : undefined;
  let includeProject = req.query.includeProject === '1' || req.query.includeProject === 'true';

  // AI Panel: return panel sessions for specific room + user. Room membership
  // must be checked before returning even channel-AI metadata.
  if (roomId && userId) {
    const access = await canAccessRoom(roomId, userId, role || 'member');
    if (!access.allowed) return res.status(access.status).json({ error: access.message });
    return res.json(await getPanelSessions(roomId, userId));
  }

  // Session AI Panel: return panel threads for a specific parent session + user
  if (parentSessionId && userId) {
    const access = await canAccessSession(parentSessionId, userId, role);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });
    if (includeProject) {
      const parent = await queryOne<{ project_id: string | null }>('SELECT project_id FROM sessions WHERE id = $1', [parentSessionId]);
      const projectAccess = parent?.project_id ? await canCreateInProject(parent.project_id, userId, role) : { allowed: false };
      includeProject = projectAccess.allowed === true;
    }
    return res.json(await getSessionPanelSessions(parentSessionId, userId, { includeProject, role: role || 'member' }));
  }

  // Default: return accessible first-class sidebar sessions. `limit` is applied
  // after visibility/sidebar filters at SQL level so startup can request only
  // the recent window instead of downloading every historical session.
  const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : undefined;
  const sessions = await getSessions(userId, role, { limit, projectId, sidebarOnly: true });
  res.json(sessions);
});

router.post('/sessions', async (req, res) => {
  const { name, cwd, engine, roomId, sourceMessageId, parentSessionId, label, modelUsed, visibility } = req.body;
  let { projectId } = req.body;
  const userId = (req as any).user?.userId;
  const role = (req as any).user?.role;

  const { resolveSessionCreationContext } = await import('../../services/session/session-creation-context.js');
  const resolvedContext = await resolveSessionCreationContext({ cwd, projectId, parentSessionId, roomId, userId, role });
  projectId = resolvedContext.projectId;
  const effectiveCwd = resolvedContext.cwd;

  // Project access check for session creation
  if (projectId && userId) {
    const access = await canCreateInProject(projectId, userId, role);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });
  }
  // label: optional — when the user hits "+" on a deck (label group), the new session
  // is created already tagged so it lands in that deck without a second PATCH roundtrip.
  const normalizedLabel = typeof label === 'string' && label.trim() ? label.trim() : undefined;
  // modelUsed: optional explicit value from caller. When absent + parentSessionId given,
  // createSession() auto-inherits parent's model_used IF the engine matches.
  // (Panel sessions: parent decides. See decisions/2026-05-17-pi-panel-session-model-used-bug.md)
  const normalizedModelUsed = typeof modelUsed === 'string' && modelUsed.trim() ? modelUsed.trim() : undefined;
  const normalizedVisibility = visibility === 'project' || visibility === 'private' ? visibility : undefined;
  const session = await createSession(name || `Session ${new Date().toLocaleString('en-US')}`, effectiveCwd, userId, projectId, engine, roomId, sourceMessageId, parentSessionId, normalizedLabel, normalizedModelUsed);
  if (normalizedVisibility && session.visibility !== normalizedVisibility) {
    await updateSession(session.id, { visibility: normalizedVisibility });
    session.visibility = normalizedVisibility;
  }
  if (userId) broadcastToUser(userId, { type: 'session_created', session });
  else broadcastToAll({ type: 'session_created', session });
  res.json(session);
});

router.get('/sessions/:id', async (req, res) => {
  const userId = (req as any).user?.userId;
  const role = (req as any).user?.role;
  const key = req.params.id as string;
  const session = await getSessionByKey(key, userId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  // Project access check. Resolve shortCode → UUID first so access policy keeps
  // using the canonical sessions.id primary key.
  if (userId) {
    const access = await canAccessSession(session.id, userId, role);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });
  }
  res.json(session);
});

// ───── Session + Messages (combined endpoint for fast session switching) ─────
router.get('/sessions/:id/full', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (userId) {
      const access = await canAccessSession(req.params.id as string, userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }
    const limit = parseInt(req.query.limit as string) || 100;
    const [session, msgResult] = await Promise.all([
      getSession(req.params.id as string),
      getMessagesPaginated(req.params.id as string, { limit }),
    ]);
    res.json({ session, ...msgResult });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ───── Session Messages ─────
// Supports pagination: ?limit=100&before=<messageId>
// Without params → returns all messages (backward-compatible)
// With limit → returns { messages, hasMore, oldestId }
router.get('/sessions/:id/messages', async (req, res) => {
  try {
    // Project access check
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (userId) {
      const access = await canAccessSession(req.params.id as string, userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }

    const limitParam = req.query.limit as string | undefined;
    const before = req.query.before as string | undefined;

    if (limitParam) {
      // Paginated mode
      const result = await getMessagesPaginated(req.params.id as string, {
        limit: parseInt(limitParam) || 100,
        before,
      });
      res.json(result);
    } else {
      // Legacy mode — return flat array (backward-compatible)
      const messages = await getMessages(req.params.id as string);
      res.json(messages);
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
