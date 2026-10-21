/** Default-off team management API. Parent owns mounting; no direct authority writes here. */
import { Router, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../services/auth/auth.js';
import { query, queryOne } from '../db/pg-repo.js';
import { createTeamManagementIntent, applyTeamManagementIntent } from '../services/agent-workspaces/team-management-intent.js';

const router = Router();
const id = z.string().min(1).max(200).refine(value => !!value.trim());
const commandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), teamId: id, name: id }).strict(),
  z.object({ kind: z.literal('invite'), teamId: id, userId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ kind: z.literal('revoke'), teamId: id, userId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ kind: z.literal('assign'), teamId: id, projectId: id }).strict(),
]);
const applySchema = z.object({
  intentId: z.string().uuid(), proposalHash: z.string().regex(/^[0-9a-f]{64}$/), confirmed: z.literal(true),
}).strict();

function respondError(res: Response, error: unknown) {
  const code = error instanceof Error ? error.message : '';
  const statuses: Record<string, number> = {
    TEAM_MANAGEMENT_INPUT_INVALID: 400, TEAM_MANAGEMENT_CONFIRMATION_REQUIRED: 400,
    TEAM_MANAGEMENT_ADMIN_REQUIRED: 403, TEAM_MANAGEMENT_INVITEE_INELIGIBLE: 403, TEAM_MANAGEMENT_INTENT_BINDING: 403,
    TEAM_MANAGEMENT_INTENT_NOT_FOUND: 404, TEAM_MANAGEMENT_USER_REQUIRED: 404,
    TEAM_MANAGEMENT_TEAM_INACTIVE: 409, TEAM_MANAGEMENT_AGENT_INACTIVE: 409, TEAM_MANAGEMENT_TEAM_EXISTS: 409,
    TEAM_MANAGEMENT_REASSIGNMENT_REQUIRES_MIGRATION: 409, TEAM_MANAGEMENT_PREVIEW_STALE: 409,
    TEAM_MANAGEMENT_INTENT_CONSUMED: 409, TEAM_MANAGEMENT_INTENT_EXPIRED: 410,
  };
  return res.status(statuses[code] ?? 500).json({ error: statuses[code] ? code : 'TEAM_MANAGEMENT_UNAVAILABLE' });
}

router.use((_, res, next) => {
  if (process.env.TOWER_TEAM_MANAGEMENT_ENABLED !== '1') return res.status(404).json({ error: 'TEAM_MANAGEMENT_INACTIVE' });
  next();
});
router.use(authMiddleware);
router.use(async (req, res, next) => {
  // Nested auth sees router-relative paths. Never admit subsystem-scoped service tokens.
  if ((req as any).user?.aud) return res.status(403).json({ error: 'TEAM_MANAGEMENT_AUTH_SCOPE_DENIED' });
  const actorUserId = (req as any).user?.userId;
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) return res.status(401).json({ error: 'TEAM_MANAGEMENT_AUTH_REQUIRED' });
  try {
    const actor = await queryOne<{ role: string; disabled: number; approval_status: string }>(
      'SELECT role,disabled,approval_status FROM users WHERE id=$1', [actorUserId]);
    if (!actor || actor.role !== 'admin' || actor.disabled !== 0 || actor.approval_status !== 'active') {
      return res.status(403).json({ error: 'TEAM_MANAGEMENT_ADMIN_REQUIRED' });
    }
    res.locals.actorUserId = actorUserId;
    next();
  } catch (error) { respondError(res, error); }
});

router.get('/', async (_, res) => {
  try {
    const teams = await query('SELECT id,name,state,version FROM agent_teams ORDER BY name,id LIMIT 257');
    if (teams.length > 256) return res.status(409).json({ error: 'TEAM_MANAGEMENT_LIST_LIMIT' });
    return res.json({ teams });
  } catch (error) { return respondError(res, error); }
});
router.post('/preview', async (req, res) => {
  const parsed = commandSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'TEAM_MANAGEMENT_INPUT_INVALID' });
  try {
    const intent = await createTeamManagementIntent({ actorUserId: res.locals.actorUserId, command: parsed.data });
    return res.json({ ...intent, impact: {
      eligibleAgentCount: null, registeredWorkspaceCount: null, affectedOwnSessionCount: null,
      note: '영향을 받는 Agent·작업 폴더·본인 대화의 개수는 아직 확인되지 않았습니다. 0개를 의미하지 않습니다.',
      warning: '초대·Agent 배정은 팀 이용·파일 공유 범위를 확대할 수 있습니다. 다른 사람의 대화·credential·시스템 권한은 부여하지 않습니다. 팀 이용권을 철회하면 해당 팀 Agent의 자기 대화를 포함한 열람·재개를 차단합니다. 파일·대화는 삭제하지 않으며, 이미 전달된 외부 스냅샷은 자동 회수되지 않습니다.',
    } });
  } catch (error) { return respondError(res, error); }
});
router.post('/apply', async (req, res) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'TEAM_MANAGEMENT_INPUT_INVALID' });
  try {
    return res.json(await applyTeamManagementIntent({ actorUserId: res.locals.actorUserId, ...parsed.data }));
  } catch (error) { return respondError(res, error); }
});
router.get('/:teamId', async (req, res) => {
  const parsed = id.safeParse(req.params.teamId);
  if (!parsed.success) return res.status(400).json({ error: 'TEAM_MANAGEMENT_INPUT_INVALID' });
  try {
    const teams = await query('SELECT id,name,state,version FROM agent_teams WHERE id=$1', [parsed.data]);
    if (!teams[0]) return res.status(404).json({ error: 'TEAM_MANAGEMENT_TEAM_NOT_FOUND' });
    const members = await query(`SELECT m.user_id AS "userId",m.state,u.role
      FROM agent_team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 ORDER BY m.user_id LIMIT 257`, [parsed.data]);
    const agents = await query('SELECT project_id AS "projectId" FROM agent_team_projects WHERE team_id=$1 ORDER BY project_id LIMIT 257', [parsed.data]);
    if (members.length > 256 || agents.length > 256) return res.status(409).json({ error: 'TEAM_MANAGEMENT_LIST_LIMIT' });
    return res.json({ team: teams[0], members, agents });
  } catch (error) { return respondError(res, error); }
});
export default router;
