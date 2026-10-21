import { randomUUID } from 'node:crypto';
import { queryOne } from '../db/pg-repo.js';
import { chatHistory, chatReply } from '../services/secretariat/chat.js';
import { Router } from 'express';
import { z } from 'zod';
import { secretariatService, SecretariatAccessError } from '../services/secretariat/service.js';

export function createSecretariatRouter(service = secretariatService) {
  const router = Router();
  router.use((req, res, next) => {
    const { userId, role } = (req as any).user || {};
    if (!Number.isInteger(userId) || userId < 1 || !['admin', 'operator', 'member'].includes(role)) {
      res.status(403).json({ error: 'Unauthorized' }); return;
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const fail = (res: any, error: unknown) => res.status(error instanceof SecretariatAccessError ? error.status : 503)
    .json({ error: error instanceof SecretariatAccessError ? error.message : 'Secretariat unavailable' });
  router.get('/', async (req, res) => {
    try { res.json(await service.inbox((req as any).user.userId)); }
    catch (error) { fail(res, error); }
  });
  router.patch('/', async (req, res) => {
    const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid settings' }); return; }
    try { res.json(await service.setEnabled((req as any).user.userId, parsed.data.enabled)); }
    catch (error) { fail(res, error); }
  });
  router.post('/proposals/:id/read', async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) { res.status(400).json({ error: 'Invalid proposal' }); return; }
    try {
      if (!await service.read((req as any).user.userId, id.data)) { res.status(404).json({ error: 'Proposal not found' }); return; }
      res.json({ ok: true });
    } catch (error) { fail(res, error); }
  });
  router.post('/proposals/:id/respond', async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    const body = z.object({ action: z.enum(['show', 'skip', 'today']) }).strict().safeParse(req.body);
    if (!id.success || !body.success) { res.status(400).json({ error: 'Invalid response' }); return; }
    try {
      if (!await service.respond((req as any).user.userId, id.data, body.data.action)) {
        res.status(409).json({ error: 'Proposal unavailable' }); return;
      }
      res.json({ ok: true });
    } catch (error) { fail(res, error); }
  });
  router.post('/briefing', async (req, res) => {
    if (req.body && Object.keys(req.body).length) { res.status(400).json({ error: 'No arguments allowed' }); return; }
    try {
      const userId = (req as any).user.userId;
      const before = await service.inbox(userId);
      const existing = before.proposals.find(p => !p.readAt);
      if (existing) { res.json({ status: 'existing', snapshot: before, proposalId: existing.id }); return; }
      const status = await service.runUser(userId, true);
      const snapshot = await service.inbox(userId);
      res.json({ status, snapshot, proposalId: snapshot.proposals.find(p => !p.readAt)?.id ?? null });
    } catch (error) { fail(res, error); }
  });
  router.get('/chat', async (req, res) => {
    try { res.json(await chatHistory((req as any).user.userId)); } catch (error) { fail(res,error); }
  });
  router.get('/chat/requests/:id', async(req,res)=>{
    const id=z.uuid().safeParse(req.params.id);if(!id.success){res.status(400).json({error:'Invalid request'});return;}
    try{
      const userId=(req as any).user.userId;
      const snapshot=await chatHistory(userId);
      const turn=await queryOne<{status:string}>('SELECT status FROM secretariat_conversation_turns WHERE user_id=$1 AND request_id=$2',[userId,id.data]);
      res.setHeader('Cache-Control','no-store');res.json({status:turn?.status||'unknown',snapshot});
    }catch(error){fail(res,error);}
  });
  router.post('/chat/requests/:id/resolve', async(req,res)=>{
    const id=z.uuid().safeParse(req.params.id);if(!id.success){res.status(400).json({error:'Invalid request'});return;}
    try{
      const userId=(req as any).user.userId;
      const snapshot=await chatHistory(userId);
      // Tombstone wins against delayed registration; active/finished turns remain authoritative.
      const row=await queryOne<{status:string}>(`INSERT INTO secretariat_conversation_turns(id,user_id,session_id,status,request_id,finished_at)
        VALUES($4,$2,$3,'interrupted',$1::uuid,NOW())
        ON CONFLICT(user_id,request_id) WHERE request_id IS NOT NULL
        DO UPDATE SET request_id=EXCLUDED.request_id RETURNING status`,[id.data,userId,snapshot.conversationId,randomUUID()]);
      res.setHeader('Cache-Control','no-store');res.json({status:row?.status||'unknown',snapshot});
    }catch(error){fail(res,error);}
  });
  router.post('/chat/stream', async (req, res) => {
    const parsed=z.object({message:z.string().trim().min(1).max(2000),requestId:z.uuid().optional()}).strict().safeParse(req.body);
    if(!parsed.success){res.status(400).json({error:'Invalid message'});return;}
    const controller=new AbortController();
    res.on('close',()=>controller.abort());
    res.setHeader('Content-Type','application/x-ndjson');res.setHeader('Cache-Control','no-store');res.setHeader('X-Accel-Buffering','no');
    const emit=(event:unknown)=>{if(!res.destroyed)res.write(JSON.stringify(event)+'\n');};
    try {
      const result=await chatReply((req as any).user.userId,parsed.data.message,undefined,{requestId:parsed.data.requestId,signal:controller.signal,
        onText:text=>emit({type:'text',text}),onCompact:stage=>emit({type:'compact',stage})});
      emit({type:'done',result});
    } catch {emit({type:'error',message:'답변이 중단되었거나 저장하지 못했습니다. 다시 시도해 주세요.'});}
    finally{res.end();}
  });
  router.post('/chat', async (req, res) => {
    const body = z.object({ message: z.string().trim().min(1).max(2000), contextId: z.string().uuid().nullable().optional() }).strict().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'Invalid message' }); return; }
    try { res.json(await chatReply((req as any).user.userId,body.data.message,body.data.contextId)); }
    catch (error) {
      if (error instanceof Error && error.message === 'chat_busy') { res.status(409).json({error:'잠시 후 다시 보내주세요.'}); return; }
      fail(res,error);
    }
  });
  return router;
}
export default createSecretariatRouter();
