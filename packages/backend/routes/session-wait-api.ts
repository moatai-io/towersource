import { Router } from 'express';
import { z } from 'zod';
import { getSession } from '../services/session/session-manager.js';
import { queryOne } from '../db/pg-repo.js';
import { canAccessSession } from '../services/pm/project-access.js';
import { assertWaitPrincipal, changeWaitAlarm, readWaitAlarm, WaitAlarmError } from '../services/agent-sleep/alarms.js';
const router=Router();
const mutation=z.object({id:z.string().min(1).max(100),version:z.number().int().positive(),wakeAt:z.string().optional()}).strict();
router.all(['/sessions/:id/wait-alarm','/sessions/:id/wait-alarm/:action'],async(req,res)=>{
 const principal=(req as any).user;if(!principal?.userId)return res.status(401).json({error:'Unauthorized'});
 const id=String(req.params.id);const action=String(req.params.action||'');
 try{
  const session=await getSession(id);if(!session)return res.status(404).json({error:'Session not found'});
  const access=await canAccessSession(id,principal.userId,principal.role);if(!access.allowed)return res.status(403).json({error:'Session access denied'});
  const owner=await queryOne<{user_id:number}>('SELECT user_id FROM sessions WHERE id=$1',[id]);
  let canManage=owner?.user_id===principal.userId;
  if(canManage){try{await assertWaitPrincipal(id,principal.userId);}catch{canManage=false;}}
  res.setHeader('Cache-Control','no-store');
  if(req.method==='GET'&&!action)return res.json({alarm:await readWaitAlarm(id),canManage});
  if(req.method!=='POST'||!['now','cancel','reschedule'].includes(action))return res.status(405).json({error:'Method not allowed'});
  if(!canManage)return res.status(403).json({error:'Only the session owner may change an alarm'});
  const parsed=mutation.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Invalid alarm request'});
  return res.json({alarm:await changeWaitAlarm(id,action as 'now'|'cancel'|'reschedule',parsed.data),canManage});
 }catch(e){if(e instanceof WaitAlarmError)return res.status(e.status).json({error:e.message});console.error('[wait-alarm] request failed',e instanceof Error?e.message:'unknown');return res.status(503).json({error:'Wait alarm unavailable'});}
});
export default router;
