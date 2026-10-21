import { readDurableInterview, answerDurableInterview } from '../../services/agents/durable-interview.js';
import { readAutomaticInterview } from '../../services/agents/automatic-interview.js';
import { readInterview, answerInterview } from '../../services/agents/agent-interview.js';
import { getProject } from '../../services/pm/project-manager.js';
import sessionTrashRouter from './session-trash-router.js';
import administratorParticipationRouter from './administrator-participation-router.js';
/**
 * Owns: authenticated Session listing, creation, lookup, and message reads.
 * Public API: sessionCoreRouter. See README.md.
 */
import { Router } from 'express';
import {
  createSession, getPanelSessions, getSession, getSessionByKey,
  getSessionPanelSessions, getSessions,
} from '../../services/session/session-manager.js';
import { getComposerMessageContext, getMessages, getMessagesPaginated } from '../../services/message-store.js';
import { extractTextFromContent } from '../../utils/text.js';
import { buildComposerActions } from '../../services/session-navigator/composer-actions.js';
import { canAccessRoom, canAccessSession, canSendSessionMessage, canCreateInProject, canInspectSessionMetadata } from '../../services/pm/project-access.js';
import { queryOne } from '../../db/pg-repo.js';
import { broadcastToAll, broadcastToUser } from '../ws-handler.js';

const router = Router();
router.use(administratorParticipationRouter);
router.use(sessionTrashRouter);

/** Do not return previews/configuration when only company metadata is readable. */
async function visibleSessionMetadata<T extends { id: string }>(sessions: T[], userId: number, role: string) {
  const visible = await Promise.all(sessions.map(async (session) => {
    if ((await canAccessSession(session.id, userId, role)).allowed) return session;
    if (!(await canInspectSessionMetadata(session.id, userId, role)).allowed) return null;
    const row = session as T & Record<string, unknown>;
    return Object.fromEntries([
      'id', 'shortCode', 'name', 'projectId', 'visibility', 'ownerUsername', 'createdAt', 'updatedAt',
    ].filter(key => key in row).map(key => [key, row[key]]));
  }));
  return visible.filter(session => session !== null);
}

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
    const sessions = await getPanelSessions(roomId, userId);
    return res.json(await visibleSessionMetadata(sessions, userId, role || 'member'));
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
    const sessions = await getSessionPanelSessions(parentSessionId, userId, { includeProject, role: role || 'member' });
    return res.json(await visibleSessionMetadata(sessions, userId, role || 'member'));
  }

  // Default: return accessible first-class sidebar sessions. `limit` is applied
  // after manager sidebar filters at SQL level. The defensive audience pass
  // below may return fewer rows until manager SQL adopts the same audience gate.
  // A caller that omits `limit` still gets a bounded query: getSessions() runs
  // per-row LATERAL joins against `messages`, so an unbounded fetch on a
  // project with thousands of sessions took 9+ seconds and stalled the shared
  // pg pool for every other request (dev and prod alike, same Postgres).
  const DEFAULT_SESSIONS_LIMIT = 200;
  const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : DEFAULT_SESSIONS_LIMIT;
  const sessions = await getSessions(userId, role, { limit, projectId, sidebarOnly: true });
  res.json(sessions);
});

router.post('/sessions', async (req, res) => {
  const { name, cwd, engine, roomId, sourceMessageId, parentSessionId, label, modelUsed, visibility } = req.body;
  let { projectId } = req.body;
  const userId = (req as any).user?.userId;
  const role = (req as any).user?.role;

  // Guard audience references before inheritance can expose another conversation's
  // context or a channel's execution identity. Reading a parent grants no send.
  if (userId) {
    if (parentSessionId) {
      const access = await canAccessSession(parentSessionId, userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }
    if (roomId) {
      const access = await canAccessRoom(roomId, userId, role || 'member');
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }
    const roleAccess = await canCreateInProject(null, userId, role);
    if (!roleAccess.allowed) return res.status(roleAccess.status).json({ error: roleAccess.message });
  }

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
  const session = await createSession(name || `Session ${new Date().toLocaleString('en-US')}`, effectiveCwd, userId, projectId, engine, roomId, sourceMessageId, parentSessionId, normalizedLabel, normalizedModelUsed, { visibility: normalizedVisibility });
  if (userId) broadcastToUser(userId, { type: 'session_created', session });
  else broadcastToAll({ type: 'session_created', session });
  res.json(session);
});

router.get('/sessions/:id/composer-actions', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const sessionId = req.params.id as string;
    if (userId) {
      const access = await canAccessSession(sessionId, userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }
    const context = await getComposerMessageContext(sessionId);
    if (context.content === null) {
      return res.json({ contextRevision: 0, mode: 'guide', source: 'tower_rule', recommendedActionId: null, actions: [], autoMode: { available: false, status: 'coming_soon' } });
    }
    const language = typeof req.query.language === 'string' ? req.query.language : 'en';
    const latestAssistantText = extractTextFromContent(context.content).trim();
    res.json(buildComposerActions({
      latestAssistantText,
      contextRevision: context.contextRevision,
      language,
    }));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
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

// Interview state is scoped by the same Session ACL as messages. No model is invoked here.
router.get('/sessions/:id/initial-interview', async (req, res) => {
  const user=(req as any).user;
  if(!user?.userId)return res.status(401).json({error:'Authentication required'});
  const access=await canAccessSession(req.params.id as string,user.userId,user.role);
  if(!access.allowed)return res.status(access.status).json({error:access.message});
  const session=await getSession(req.params.id as string);
  const project=session?.projectId?await getProject(session.projectId):null;
  const durable=project?.id?await readDurableInterview(project.id).catch(()=>null):null;
  if(durable)return res.json({state:{questionId:durable.question_id,question:durable.question,status:durable.status},execution:durable.status});
  const state=project?.rootPath?readInterview(project.rootPath):null;
  return res.json({execution:project?.rootPath?readAutomaticInterview(project.rootPath):null,state:state?{questionId:state.questionId,revision:state.revision,status:state.status}:null});
});
router.post('/sessions/:id/initial-interview', async (req, res) => {
  const user=(req as any).user;
  if(!user?.userId)return res.status(401).json({error:'Authentication required'});
  const access=await canSendSessionMessage(req.params.id as string,user.userId,user.role);
  if(!access.allowed)return res.status(access.status).json({error:access.message});
  const {questionId,revision,answer}=req.body??{};
  if(typeof questionId!=='string'||!(answer===null||typeof answer==='string'))return res.status(400).json({error:'Invalid interview input'});
  const session=await getSession(req.params.id as string);
  const project=session?.projectId?await getProject(session.projectId):null;
  if(!project?.rootPath)return res.status(404).json({error:'Project unavailable'});
  const durable=await readDurableInterview(project.id).catch(()=>null);
  if(durable){try{return res.json({state:await answerDurableInterview(project.id,session!.id,questionId,answer)});}catch{return res.status(409).json({error:'질문 상태가 변경되었습니다.'});}}
  try {const state=answerInterview(project.rootPath,questionId,revision,answer);return res.json({state:{questionId:state.questionId,revision:state.revision,status:state.status}});}
  catch{return res.status(409).json({error:'인터뷰 상태가 변경되었습니다. 새로고침 후 확인해 주세요.'});}
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
