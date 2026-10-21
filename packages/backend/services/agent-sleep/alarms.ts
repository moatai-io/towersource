/** Durable one-shot waits. Persistence and admission are distinct from external effect idempotency. */
import { randomUUID } from 'node:crypto';
import { canSendSessionMessage } from '../pm/project-access.js';
import { query, queryOne, transaction } from '../../db/pg-repo.js';
import { getCurrentRootTurn } from '../agent-turn/current-root-turn.js';
export const MAX_WAIT_SECONDS = 30 * 86400;
export const WAIT_DESCRIPTION = 'Save a one-shot session alarm and end this execution. durationSeconds is 1–2592000 (30 days); reason describes the next check. The same session resumes after the saved time, including after server restart, when idle. A newer user instruction or Stop cancels the old alarm. Do not use wait instead of a required user answer or for recurring schedules. External side effects are not guaranteed exactly once.';
export interface WaitAlarm { id:string; sessionId:string; status:'pending'|'admitted'|'cancelled'|'superseded'; wakeAt:string; reason:string; version:number; createdAt:string; updatedAt:string }
interface AlarmRow { id:string; session_id:string; status:WaitAlarm['status']; wake_at:string|Date; reason:string; version:number; created_at:string|Date; updated_at:string|Date; source_root_turn_id:string; owner_user_id:number; resume_message_id:string }
export const alarmDto = (r:AlarmRow):WaitAlarm => ({id:r.id,sessionId:r.session_id,status:r.status,wakeAt:new Date(r.wake_at).toISOString(),reason:r.reason,version:r.version,createdAt:new Date(r.created_at).toISOString(),updatedAt:new Date(r.updated_at).toISOString()});
export class WaitAlarmError extends Error { constructor(public status:number,message:string){super(message);} }
const parked = new Map<string,WaitAlarm>();
const generations = new Map<string,number>();
export function getRequestedWait(sessionId:string){return parked.get(sessionId);}
export function clearRequestedWait(sessionId:string){parked.delete(sessionId);}
export function validateWait(input:{durationSeconds:number;reason:string}) {
 if(!input || !Number.isInteger(input.durationSeconds)||input.durationSeconds<1||input.durationSeconds>MAX_WAIT_SECONDS) throw new WaitAlarmError(400,'durationSeconds must be 1–2592000');
 if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.trim().length>500)throw new WaitAlarmError(400,'reason must be 1–500 characters');
 return {...input,reason:input.reason.trim()};
}
export function validateWakeAt(value:string,now=Date.now()) {const at=Date.parse(value);if(!Number.isFinite(at)||at<=now||at>now+MAX_WAIT_SECONDS*1000)throw new WaitAlarmError(400,'wakeAt must be a future time within 30 days');return new Date(at).toISOString();}
export async function scheduleWait(input:{durationSeconds:number;reason:string},ctx:{sessionId:string;rootTurnId?:string}) {
 const generation=generations.get(ctx.sessionId)||0;const valid=validateWait(input);const root=getCurrentRootTurn(ctx.sessionId)||ctx.rootTurnId;if(!root)throw new WaitAlarmError(409,'wait requires an active root turn');
 const id=randomUUID();const wakeAt=new Date(Date.now()+valid.durationSeconds*1000).toISOString();
 const result=await transaction(async c=>{
  const s=await c.query('SELECT user_id FROM sessions WHERE id=$1 AND COALESCE(archived,0)=0 FOR UPDATE',[ctx.sessionId]);if(!s.rows[0])throw new WaitAlarmError(404,'Session unavailable');
  if((generations.get(ctx.sessionId)||0)!==generation)throw new WaitAlarmError(409,'Wait was cancelled');
  const source=await c.query(`SELECT m.id FROM messages m JOIN agent_turns t ON t.root_turn_id=m.id WHERE m.id=$1 AND m.session_id=$2 AND m.role='user' AND t.state='running' AND t.owner_token IS NOT NULL AND t.lease_until>NOW()`,[root,ctx.sessionId]);if(!source.rows.length)throw new WaitAlarmError(409,'No active source turn');
  const newer=await c.query(`SELECT 1 FROM messages WHERE session_id=$1 AND role='user' AND COALESCE(metadata->>'origin','')<>'system-agent-wait' AND id<>$2 AND created_at>(SELECT created_at FROM messages WHERE id=$2) LIMIT 1`,[ctx.sessionId,root]);if(newer.rows.length)throw new WaitAlarmError(409,'A newer instruction superseded this turn');
  await c.query(`UPDATE session_wait_alarms SET status='superseded',version=version+1,updated_at=NOW() WHERE session_id=$1 AND status='pending'`,[ctx.sessionId]);
  const a=await c.query<AlarmRow>(`INSERT INTO session_wait_alarms(id,session_id,source_root_turn_id,owner_user_id,wake_at,reason,resume_message_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[id,ctx.sessionId,root,s.rows[0].user_id,wakeAt,valid.reason,`wait-alarm:${id}`]);
  // The source is intentionally parked, never a crash-recovery candidate. Retain the running lease until engine unwind.
  await c.query(`UPDATE agent_turns SET last_failure_class='wait_requested',next_attempt_at=NULL,updated_at=NOW() WHERE root_turn_id=$1 AND session_id=$2`,[root,ctx.sessionId]);
  return alarmDto(a.rows[0]);
 });if((generations.get(ctx.sessionId)||0)!==generation){await invalidateWaitAlarm(ctx.sessionId);throw new WaitAlarmError(409,'Wait superseded');}parked.set(ctx.sessionId,result);return {ok:true,status:'scheduled' as const,alarm:result};
}
export async function readWaitAlarm(sessionId:string){const row=await queryOne<AlarmRow>('SELECT * FROM session_wait_alarms WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[sessionId]);return row?alarmDto(row):null;}
export async function invalidateWaitAlarm(sessionId:string,status:'cancelled'|'superseded'='superseded') {
 generations.set(sessionId,(generations.get(sessionId)||0)+1);parked.delete(sessionId);await transaction(async c=>{await c.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE',[sessionId]);await c.query(`UPDATE agent_turns t SET state='stopped_clean',owner_token=NULL,owner_boot_id=NULL,lease_until=NULL,next_attempt_at=NULL,terminal_at=NOW(),updated_at=NOW() WHERE t.session_id=$1 AND t.state IN ('running','waiting_retry','stop_requested') AND ($2='cancelled' OR t.owner_token IS NULL) AND EXISTS(SELECT 1 FROM session_wait_alarms a WHERE a.resume_message_id=t.root_turn_id AND a.status='admitted')`,[sessionId,status]);await c.query(`UPDATE session_wait_alarms SET status=$2,version=version+1,updated_at=NOW() WHERE session_id=$1 AND status IN ('pending','admitted')`,[sessionId,status]);});
}
export async function changeWaitAlarm(sessionId:string,action:'now'|'cancel'|'reschedule',input:{id:string;version:number;wakeAt?:string}){
 const wakeAt=action==='reschedule'?validateWakeAt(input.wakeAt||''):new Date().toISOString();
 const row=await queryOne<AlarmRow>(`UPDATE session_wait_alarms SET status=CASE WHEN $4='cancel' THEN 'cancelled' ELSE status END,wake_at=CASE WHEN $4='cancel' THEN wake_at ELSE $5::timestamptz END,version=version+1,updated_at=NOW() WHERE session_id=$1 AND id=$2 AND version=$3 AND status='pending' RETURNING *`,[sessionId,input.id,input.version,action,wakeAt]);
 if(!row)throw new WaitAlarmError(409,'Alarm changed or is no longer pending');if(action==='cancel')parked.delete(sessionId);return alarmDto(row);
}
/** Retire only superseded, unowned retries. Never retire running/approval work. */
export async function retireSupersededWaitRetries() {
 return transaction(async c=>{
  const due=await c.query(`SELECT a.session_id,a.source_root_turn_id FROM session_wait_alarms a WHERE a.status='pending' AND a.wake_at<=NOW() ORDER BY a.wake_at LIMIT 100`);
  let retired=0;
  for(const alarm of due.rows){
   await c.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE',[alarm.session_id]);
   const result=await c.query(`UPDATE agent_turns t SET state='needs_attention',last_failure_class='restart_recovery_superseded',last_error='Retry superseded by a newer user request that scheduled a wait alarm.',next_attempt_at=NULL,updated_at=NOW()
    WHERE t.session_id=$1 AND t.state='waiting_retry' AND t.owner_token IS NULL
      AND (t.lease_until IS NULL OR t.lease_until<=NOW())
      AND COALESCE(t.last_failure_class,'') NOT IN ('abandoned_side_effect_uncertain','wait_requested')
      AND EXISTS(SELECT 1 FROM session_wait_alarms a JOIN messages source ON source.id=a.source_root_turn_id JOIN messages old ON old.id=t.root_turn_id
        WHERE a.session_id=t.session_id AND a.source_root_turn_id=$2 AND a.status='pending' AND a.wake_at<=NOW()
        AND source.session_id=t.session_id AND old.session_id=t.session_id AND source.role='user' AND source.created_at>old.created_at
        AND COALESCE(source.metadata->>'origin','human') NOT LIKE 'system%')`,[alarm.session_id,alarm.source_root_turn_id]);
   retired+=result.rowCount||0;
  }
  return retired;
 });
}
export async function listDueWaitAlarms(){return query<AlarmRow>(`SELECT a.* FROM session_wait_alarms a WHERE a.status='pending' AND a.wake_at<=NOW() AND NOT EXISTS(SELECT 1 FROM agent_turns t WHERE t.session_id=a.session_id AND ((t.owner_token IS NOT NULL AND t.lease_until>NOW()) OR (t.state IN ('running','waiting_retry','stop_requested','waiting_user','waiting_approval') AND COALESCE(t.last_failure_class,'')<>'wait_requested'))) ORDER BY a.wake_at LIMIT 100`);}
/** Called only from handleChat while its shared session admission lock is held.
 * Stable message + root registration + alarm CAS commit together. Busy consumes nothing. */
export async function admitWaitAlarm(sessionId:string,id:string,version?:number){
 return transaction(async c=>{
  await c.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE',[sessionId]);
  const row=(await c.query<AlarmRow>(`SELECT * FROM session_wait_alarms WHERE id=$1 AND session_id=$2 AND status='pending' AND wake_at<=NOW() FOR UPDATE`,[id,sessionId])).rows[0];if(!row || (version !== undefined && row.version !== version))return null;
  const newer=await c.query(`SELECT 1 FROM messages WHERE session_id=$1 AND role='user' AND COALESCE(metadata->>'origin','')<>'system-agent-wait' AND id<>$2 AND created_at>(SELECT created_at FROM messages WHERE id=$2) LIMIT 1`,[sessionId,row.source_root_turn_id]);
  if(newer.rows.length){await c.query(`UPDATE session_wait_alarms SET status='superseded',version=version+1,updated_at=NOW() WHERE id=$1`,[id]);return null;}
  const busy=await c.query(`SELECT 1 FROM agent_turns WHERE session_id=$1 AND ((state IN ('running','stop_requested','waiting_retry','waiting_user','waiting_approval') AND COALESCE(last_failure_class,'')<>'wait_requested') OR (owner_token IS NOT NULL AND lease_until>NOW())) LIMIT 1`,[sessionId]);if(busy.rows.length)return null;
  // Crash between scheduling and clean unwind: source wait marker never replays.
  await c.query(`UPDATE agent_turns SET state='completed',owner_token=NULL,owner_boot_id=NULL,lease_until=NULL,terminal_at=NOW(),completed_at=NOW(),updated_at=NOW() WHERE root_turn_id=$1 AND last_failure_class='wait_requested' AND (lease_until IS NULL OR lease_until<=NOW())`,[row.source_root_turn_id]);
  const prompt=`[Saved session wait alarm ${row.id}] The saved wait is due. Resume only the bounded next check: ${row.reason}. This is not a new human instruction. Reassess current evidence before acting; stop or ask the user if the task requires input.`;
  await c.query(`INSERT INTO messages(id,session_id,role,content,metadata) VALUES($1,$2,'user',$3::jsonb,$4::jsonb) ON CONFLICT(id) DO NOTHING`,[row.resume_message_id,sessionId,JSON.stringify([{type:'text',text:prompt}]),JSON.stringify({origin:'system-agent-wait',hidden:'system-trigger',waitAlarmId:row.id})]);
  await c.query(`INSERT INTO agent_turns(root_turn_id,session_id,state,accepted_at,execution_started_at) VALUES($1,$2,'running',NOW(),NOW()) ON CONFLICT(root_turn_id) DO NOTHING`,[row.resume_message_id,sessionId]);
  await c.query(`UPDATE session_wait_alarms SET status='admitted',version=version+1,updated_at=NOW() WHERE id=$1 AND status='pending'`,[id]);
  return {messageId:row.resume_message_id,prompt};
 });
}
export async function assertWaitPrincipal(sessionId:string,userId:number){
 const row=await queryOne<{role:string;username:string;project_id:string|null}>(`SELECT u.role,u.username,s.project_id FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN projects p ON p.id=s.project_id WHERE s.id=$1 AND s.user_id=$2 AND COALESCE(s.archived,0)=0 AND COALESCE(u.disabled,0)=0 AND u.approval_status='active' AND (s.project_id IS NULL OR (p.id IS NOT NULL AND COALESCE(p.archived,0)=0))`,[sessionId,userId]);
 if(!row)throw new WaitAlarmError(403,'Session owner or workspace is no longer active');return row;
}

/** Revalidate alarm-owned roots at the final run boundary and on crash recovery. */
export async function validateWaitAlarmRoot(sessionId:string,rootTurnId:string):Promise<boolean> {
 const row=await queryOne<{status:string;owner_user_id:number}>(`SELECT status,owner_user_id FROM session_wait_alarms WHERE session_id=$1 AND resume_message_id=$2`,[sessionId,rootTurnId]);
 if(!row) return true;
 if(row.status!=='admitted') return false;
 try { const actor=await assertWaitPrincipal(sessionId,row.owner_user_id);const permission=await canSendSessionMessage(sessionId,row.owner_user_id,actor.role);if(!permission.allowed){await invalidateWaitAlarm(sessionId);return false;}return true; } catch { await invalidateWaitAlarm(sessionId);return false; }
}
