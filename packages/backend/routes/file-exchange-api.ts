// Owns: authenticated HTTP boundary for File Exchange inspect, execute, and receipts.
import { Router } from 'express';
import { z } from 'zod';
import { confirmFileTransferPlan, executeFileTransfer, getFileTransferReceipt, inspectFileTransfer } from '../services/file-exchange/file-exchange-service.js';
import { FileExchangeError } from '../services/file-exchange/file-exchange-types.js';

const router = Router();

const sourceSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('personal'), uri: z.string().startsWith('personal://') }),
  z.object({ scope: z.literal('session'), sessionId: z.string().min(1), attachmentId: z.string().uuid() }),
  z.object({ scope: z.literal('channel'), channelId: z.string().min(1), fileId: z.string().min(1) }),
  z.object({ scope: z.literal('project'), projectId: z.string().min(1), relativePath: z.string().min(1) }),
]);
const destinationSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('personal'), relativeDirectory: z.string().optional() }),
  z.object({ scope: z.literal('session'), sessionId: z.string().min(1) }),
  z.object({ scope: z.literal('channel'), channelId: z.string().min(1) }),
  z.object({ scope: z.literal('project'), projectId: z.string().min(1), relativeDirectory: z.string().optional() }),
]);
const inspectSchema = z.object({ source: sourceSchema, destination: destinationSchema });
const planSchema = z.object({ planId: z.string().uuid() });

function actor(req: any) {
  const userId = Number(req.user?.userId);
  if (!Number.isInteger(userId) || userId <= 0) throw new FileExchangeError('FORBIDDEN', '로그인이 필요합니다.');
  return { userId, role: String(req.user?.role || 'member') };
}

function fail(res: any, error: unknown) {
  if (error instanceof z.ZodError) return res.status(400).json({ error: '잘못된 파일 전달 요청입니다.', issues: error.issues });
  if (error instanceof FileExchangeError) {
    const status = error.code === 'NOT_FOUND' ? 404
      : error.code === 'CONFLICT' || error.code === 'STALE' ? 409
        : error.code === 'CONFIRMATION_REQUIRED' ? 428
          : error.code === 'INVALID' ? 400
            : error.code === 'FORBIDDEN' ? 403 : 500;
    return res.status(status).json({ error: error.message, code: error.code, stage: error.stage });
  }
  console.error('[file-exchange]', error);
  return res.status(500).json({ error: error instanceof Error ? error.message : '파일 전달에 실패했습니다.' });
}

router.post('/inspect', async (req, res) => {
  try { res.status(201).json(await inspectFileTransfer(actor(req), inspectSchema.parse(req.body))); }
  catch (error) { fail(res, error); }
});

router.post('/confirm', async (req, res) => {
  try {
    const input = planSchema.parse(req.body);
    await confirmFileTransferPlan(actor(req), input.planId);
    res.json({ ok: true, planId: input.planId });
  } catch (error) { fail(res, error); }
});

router.post('/execute', async (req, res) => {
  try {
    const input = planSchema.parse(req.body);
    res.json(await executeFileTransfer(actor(req), input.planId));
  } catch (error) { fail(res, error); }
});

router.get('/receipts/:id', async (req, res) => {
  try { res.json(await getFileTransferReceipt(actor(req), req.params.id)); }
  catch (error) { fail(res, error); }
});

export default router;
