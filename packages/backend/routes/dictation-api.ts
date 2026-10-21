import { Router } from 'express';
import multer from 'multer';
import { authMiddleware } from '../services/auth/auth.js';
import { canAccessSession } from '../services/pm/project-access.js';
import { getSession } from '../services/session/session-manager.js';
import { resolveGatewayApiClient } from '../services/gateway-profile/gateway-profile-client.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 0 } });
const allowedTypes = new Set(['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav']);
router.post('/sessions/:sessionId/dictation', authMiddleware, async (req, res, next) => {
  try {
    const actor = (req as any).user;
    const access = await canAccessSession(String(req.params.sessionId), Number(actor.userId), actor.role);
    if (!access.allowed) { res.status(access.status).json({ error: access.message }); return; }
    next();
  } catch (error) { next(error); }
}, (req, res, next) => {
  upload.single('audio')(req, res, error => {
    if (error) { res.status(400).json({ error: '녹음 파일이 너무 크거나 올바르지 않습니다.' }); return; }
    next();
  });
}, async (req, res) => {
  if (!req.file || !req.file.size || !allowedTypes.has(req.file.mimetype.split(';')[0])) {
    res.status(400).json({ error: '지원하는 음성 파일이 필요합니다.' }); return;
  }
  try {
    const session = await getSession(String(req.params.sessionId));
    if (!session?.projectId) { res.status(409).json({ error: '프로젝트 세션이 필요합니다.' }); return; }
    const gateway = await resolveGatewayApiClient({ actorUserId: Number((req as any).user.userId), projectId: session.projectId, apiId: 'speech-to-text' });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(req.file.buffer)], { type: req.file.mimetype }), 'recording.' + ({ 'audio/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/wav': 'wav' }[req.file.mimetype] ?? 'webm'));
    form.append('language', 'ko');
    const response = await fetch(gateway.baseUrl, { method: 'POST', headers: { Authorization: `Bearer ${gateway.apiKey}` }, body: form, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) { res.status(502).json({ error: '음성 변환 서비스에 연결하지 못했습니다.' }); return; }
    const data = await response.json() as { text?: unknown };
    if (typeof data.text !== 'string' || data.text.length > 100_000) { res.status(502).json({ error: '음성 변환 결과가 올바르지 않습니다.' }); return; }
    res.json({ text: data.text });
  } catch { res.status(503).json({ error: '음성 입력 연결이 준비되지 않았거나 변환에 실패했습니다.' }); }
});
router.post('/sessions/:sessionId/dictation/session', authMiddleware, async (req, res) => {
  try {
    const actor = (req as any).user;
    const access = await canAccessSession(String(req.params.sessionId), Number(actor.userId), actor.role);
    if (!access.allowed) { res.status(access.status).json({ error: access.message }); return; }
    const session = await getSession(String(req.params.sessionId));
    if (!session?.projectId) { res.status(409).json({ error: '프로젝트 세션이 필요합니다.' }); return; }
    const gateway = await resolveGatewayApiClient({ actorUserId: Number(actor.userId), projectId: session.projectId, apiId: 'speech-to-text' });
    const upstream = await fetch(gateway.baseUrl + '/session', { method: 'POST', headers: { Authorization: `Bearer ${gateway.apiKey}` }, signal: AbortSignal.timeout(20_000) });
    if (!upstream.ok) { res.status(503).json({ error: '실시간 음성 입력 연결이 준비되지 않았습니다.' }); return; }
    const result = await upstream.json() as { value?: string; expires_at?: number };
    if (!result.value) { res.status(502).json({ error: '실시간 연결 응답이 올바르지 않습니다.' }); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ value: result.value, expires_at: result.expires_at });
  } catch { res.status(503).json({ error: '실시간 음성 입력 연결에 실패했습니다.' }); }
});
export default router;
