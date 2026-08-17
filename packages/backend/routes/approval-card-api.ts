// Owns: authenticated HTTP surface for Approval Cards.
// Public API: mounted at /api/approval-cards after authMiddleware.

import { Router } from 'express';
import {
  ApprovalCardError,
  createApprovalCard,
  getApprovalCard,
  listApprovalCards,
  resolveApprovalCard,
  resubmitApprovalCard,
  type ApprovalAttachmentInput,
  type ApprovalResolution,
  type ApprovalStatus,
} from '../services/approval/approval-card-manager.js';

const router = Router();

function actor(req: any): { userId: number; role: string } {
  const userId = req.user?.userId;
  if (!Number.isInteger(userId) || userId <= 0) throw new ApprovalCardError('FORBIDDEN', 'auth required');
  return { userId, role: String(req.user?.role || 'member') };
}

function errorStatus(err: unknown): number {
  if (!(err instanceof ApprovalCardError)) return 500;
  if (err.code === 'INVALID') return 400;
  if (err.code === 'FORBIDDEN') return err.message === 'auth required' ? 401 : 403;
  if (err.code === 'NOT_FOUND') return 404;
  if (err.code === 'STALE' || err.code === 'CONFLICT') return 409;
  return 500;
}

function sendError(res: any, err: unknown) {
  const status = errorStatus(err);
  if (status >= 500) console.error('[approval-cards] request failed:', err);
  res.status(status).json({ error: err instanceof Error ? err.message : 'Approval Card request failed', code: err instanceof ApprovalCardError ? err.code : 'INTERNAL' });
}

function options(value: unknown): Array<{ id: string; label: string }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ApprovalCardError('INVALID', 'options must be an array');
  return value.map((item: any) => ({ id: item?.id, label: item?.label }));
}

function attachments(value: unknown): ApprovalAttachmentInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ApprovalCardError('INVALID', 'attachments must be an array');
  return value as ApprovalAttachmentInput[];
}

router.get('/', async (req, res) => {
  try {
    const { userId, role } = actor(req);
    const box = ['assigned', 'sent', 'all'].includes(String(req.query.box)) ? req.query.box as 'assigned' | 'sent' | 'all' : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status as ApprovalStatus : undefined;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    res.json({ cards: await listApprovalCards({ userId, role, box, status, projectId, limit: Number(req.query.limit) || undefined }) });
  } catch (err) { sendError(res, err); }
});

router.post('/', async (req, res) => {
  try {
    const { userId, role } = actor(req);
    const card = await createApprovalCard({
      userId,
      role,
      projectId: req.body?.projectId,
      approverUserId: Number(req.body?.approverUserId),
      requestType: req.body?.requestType,
      title: req.body?.title,
      summaryMd: req.body?.summaryMd,
      recommendationMd: req.body?.recommendationMd,
      consequenceMd: req.body?.consequenceMd,
      options: options(req.body?.options),
      attachments: attachments(req.body?.attachments),
      sourceSessionId: req.body?.sourceSessionId,
      sourceAgentRunId: req.body?.sourceAgentRunId,
      sourceAutomationRunId: req.body?.sourceAutomationRunId,
      dueAt: req.body?.dueAt,
    });
    try {
      const { broadcastToUser } = await import('./ws-handler.js');
      broadcastToUser(card.approverUserId, { type: 'approval_card_created', cardId: card.id, projectId: card.projectId });
    } catch {}
    res.status(201).json(card);
  } catch (err) { sendError(res, err); }
});

router.get('/:id', async (req, res) => {
  try {
    const { userId, role } = actor(req);
    res.json(await getApprovalCard(req.params.id, userId, role));
  } catch (err) { sendError(res, err); }
});

router.post('/:id/resolve', async (req, res) => {
  try {
    const { userId, role } = actor(req);
    const resolution = req.body?.resolution as ApprovalResolution;
    if (!['approved', 'changes_requested', 'rejected'].includes(resolution)) throw new ApprovalCardError('INVALID', 'invalid resolution');
    const card = await resolveApprovalCard({ id: req.params.id, userId, role, resolution, commentMd: req.body?.commentMd });
    try {
      const { broadcastToUser } = await import('./ws-handler.js');
      broadcastToUser(card.submitterUserId, { type: 'approval_card_updated', cardId: card.id, status: card.status });
      if (card.approverUserId !== card.submitterUserId) broadcastToUser(card.approverUserId, { type: 'approval_card_updated', cardId: card.id, status: card.status });
    } catch {}
    res.json(card);
  } catch (err) { sendError(res, err); }
});

router.post('/:id/resubmit', async (req, res) => {
  try {
    const { userId, role } = actor(req);
    const card = await resubmitApprovalCard({
      id: req.params.id,
      userId,
      role,
      summaryMd: req.body?.summaryMd,
      recommendationMd: req.body?.recommendationMd,
      consequenceMd: req.body?.consequenceMd,
      options: options(req.body?.options),
      attachments: attachments(req.body?.attachments),
    });
    try {
      const { broadcastToUser } = await import('./ws-handler.js');
      broadcastToUser(card.approverUserId, { type: 'approval_card_updated', cardId: card.id, status: card.status });
    } catch {}
    res.json(card);
  } catch (err) { sendError(res, err); }
});

export default router;
