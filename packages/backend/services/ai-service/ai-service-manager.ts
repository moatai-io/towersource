/** Owns AI service deployment lifecycle. */
import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { execute, query, queryOne, transaction, withClient } from '../../db/pg-repo.js';
import { resolvePublishedHarnessReference } from '../harness/harness-store.js';
import { assertAIServiceActivationReady, recordServerDeployCheck } from './activation-gate.js';
import { serviceIdentityFromExperience } from './service-identity.js';
export type DeploymentStatus='draft'|'review'|'approved'|'active'|'superseded'|'revoked';
export type DeploymentEvent='submit_review'|'approve'|'activate'|'revoke';
const transitions:Record<DeploymentEvent,Partial<Record<DeploymentStatus,DeploymentStatus>>>={submit_review:{draft:'review'},approve:{review:'approved'},activate:{approved:'active',superseded:'active'},revoke:{draft:'revoked',review:'revoked',approved:'revoked',active:'revoked',superseded:'revoked'}};
export class AIServiceStateError extends Error{constructor(message:string){super(message);this.name='AIServiceStateError'}}
/** Resolve a legal transition; revoked is terminal. */
export function nextDeploymentStatus(status:DeploymentStatus,event:DeploymentEvent):DeploymentStatus{const next=transitions[event][status];if(!next)throw new AIServiceStateError(`Cannot ${event} deployment in ${status} state`);return next}
function stable(value:unknown):string{if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;if(value&&typeof value==='object')return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;return JSON.stringify(value)}
export interface DeploymentSnapshots{sourceSnapshot:unknown;policySnapshot:unknown;experienceSnapshot:unknown;evaluationSnapshot:unknown}
/** Deterministic content identity for immutable snapshots. */
export function deploymentSnapshotHash(value:DeploymentSnapshots):string{return createHash('sha256').update(stable(value)).digest('hex')}
async function transition(id:string,actor:number,event:DeploymentEvent,expectedServiceId?:string):Promise<DeploymentStatus>{return transaction(async client=>{const db=withClient(client);const row=await db.queryOne<{service_id:string;status:DeploymentStatus}>('SELECT service_id,status FROM ai_service_deployments WHERE id=$1 FOR UPDATE',[id]);if(!row)throw new AIServiceStateError('Deployment not found');if(expectedServiceId&&row.service_id!==expectedServiceId)throw new AIServiceStateError('Deployment does not belong to AI service');const next=nextDeploymentStatus(row.status,event);if(event==='approve')await db.execute('UPDATE ai_service_deployments SET status=$1,approved_by_user_id=$3,approved_at=NOW() WHERE id=$2',[next,id,actor]);else await db.execute(`UPDATE ai_service_deployments SET status=$1${event==='revoke'?',revoked_at=NOW()':''} WHERE id=$2`,[next,id]);if(event==='revoke'){await db.execute("UPDATE ai_service_channels SET status='blocked',active_deployment_id=NULL,updated_at=NOW() WHERE active_deployment_id=$1",[id]);await db.execute("UPDATE ai_services SET current_deployment_id=NULL,status='paused',updated_at=NOW() WHERE id=$1 AND current_deployment_id=$2",[row.service_id,id])}await db.execute('INSERT INTO ai_service_audit_events(service_id,deployment_id,actor_user_id,event_type) VALUES($1,$2,$3,$4)',[row.service_id,id,actor,`deployment_${event}`]);return next})}
/** Submit draft for review. */ export const submitDeploymentForReview=(id:string,actor:number,serviceId?:string)=>transition(id,actor,'submit_review',serviceId);
/** Approve without executing. */ export const approveDeployment=(id:string,actor:number,serviceId?:string)=>transition(id,actor,'approve',serviceId);
/** Terminal revoke and block serving channels. */ export const revokeDeployment=(id:string,actor:number,serviceId?:string)=>transition(id,actor,'revoke',serviceId);
/** Activate only the exact published runtime contract that passed Preview evaluation. */
export async function activateDeployment(id:string,actor:number,reason:'deploy'|'rollback'='deploy',expectedServiceId?:string):Promise<void>{await assertAIServiceActivationReady(id,expectedServiceId);await transaction(async client=>{const db=withClient(client);const row=await db.queryOne<{service_id:string;status:DeploymentStatus}>('SELECT service_id,status FROM ai_service_deployments WHERE id=$1 FOR UPDATE',[id]);if(!row)throw new AIServiceStateError('Deployment not found');if(expectedServiceId&&row.service_id!==expectedServiceId)throw new AIServiceStateError('Deployment does not belong to AI service');nextDeploymentStatus(row.status,'activate');await db.execute("UPDATE ai_service_deployments SET status='superseded' WHERE service_id=$1 AND status='active' AND id<>$2",[row.service_id,id]);await db.execute("UPDATE ai_service_deployments SET status='active',deployed_at=NOW() WHERE id=$1",[id]);await db.execute("UPDATE ai_services SET current_deployment_id=$1,status='active',updated_at=NOW() WHERE id=$2",[id,row.service_id]);await db.execute("UPDATE ai_service_channels SET active_deployment_id=$1,status='enabled',updated_at=NOW() WHERE service_id=$2 AND status<>'blocked'",[id,row.service_id]);await db.execute('INSERT INTO ai_service_audit_events(service_id,deployment_id,actor_user_id,event_type,payload) VALUES($1,$2,$3,$4,$5::jsonb)',[row.service_id,id,actor,reason==='rollback'?'deployment_rollback':'deployment_activate',JSON.stringify({reason})])})}
/** Pause serving while preserving current deployment pointer. */
export async function pauseService(serviceId:string,actor:number):Promise<void>{await transaction(async client=>{const db=withClient(client);const changed=await db.execute("UPDATE ai_services SET status='paused',updated_at=NOW() WHERE id=$1 AND status='active'",[serviceId]);if(!changed.changes)throw new AIServiceStateError('Only an active AI service can be paused');await db.execute("UPDATE ai_service_channels SET status='disabled',updated_at=NOW() WHERE service_id=$1 AND status='enabled'",[serviceId]);await db.execute("INSERT INTO ai_service_audit_events(service_id,actor_user_id,event_type) VALUES($1,$2,'service_pause')",[serviceId,actor])})}
export async function updateAIService(input:{serviceId:string;actorUserId:number;name?:string;description?:string}):Promise<AIServiceRow>{const patch:{name?:string;description?:string}={};if(input.name!==undefined){const name=input.name.trim();if(!name)throw new AIServiceStateError('AI service name required');patch.name=name}if(input.description!==undefined)patch.description=input.description.trim();if(patch.name===undefined&&patch.description===undefined)throw new AIServiceStateError('No AI service changes');const row=await queryOne<AIServiceRow>(`UPDATE ai_services SET name=COALESCE($2,name),description=COALESCE($3,description),updated_at=NOW() WHERE id=$1 AND status<>'retired' RETURNING *`,[input.serviceId,patch.name??null,patch.description??null]);if(!row)throw new AIServiceStateError('AI service not found or retired');await execute("INSERT INTO ai_service_audit_events(service_id,actor_user_id,event_type,payload) VALUES($1,$2,'service_updated',$3::jsonb)",[input.serviceId,input.actorUserId,JSON.stringify(patch)]);return row}
export async function retireAIService(serviceId:string,actor:number):Promise<void>{await transaction(async client=>{const db=withClient(client);const changed=await db.execute("UPDATE ai_services SET status='retired',current_deployment_id=NULL,updated_at=NOW() WHERE id=$1 AND status<>'retired'",[serviceId]);if(!changed.changes)throw new AIServiceStateError('AI service not found or already retired');await db.execute("UPDATE ai_service_channels SET status='disabled',active_deployment_id=NULL,updated_at=NOW() WHERE service_id=$1",[serviceId]);await db.execute("INSERT INTO ai_service_audit_events(service_id,actor_user_id,event_type) VALUES($1,$2,'service_retired')",[serviceId,actor])})}
export async function deployServiceNow(input:{serviceId:string;deploymentId?:string;actorUserId:number}):Promise<void>{const deploymentId=input.deploymentId||(await queryOne<{id:string}>(`SELECT id FROM ai_service_deployments WHERE service_id=$1 AND status IN ('draft','review','approved','superseded','active') ORDER BY version DESC LIMIT 1`,[input.serviceId]))?.id;if(!deploymentId)throw new AIServiceStateError('배포할 버전이 없습니다. AI 웹사이트 설정을 먼저 저장해 주세요.');const row=await queryOne<{status:DeploymentStatus}>(`SELECT status FROM ai_service_deployments WHERE id=$1 AND service_id=$2`,[deploymentId,input.serviceId]);if(!row)throw new AIServiceStateError('배포할 버전을 찾지 못했습니다.');const existingChannel=await queryOne<{id:string}>(`SELECT id FROM ai_service_channels WHERE service_id=$1 AND channel_type='web_link' AND status<>'blocked' ORDER BY created_at LIMIT 1`,[input.serviceId]);if(!existingChannel)await createWebLinkChannel(input.serviceId,'웹사이트 링크');if(row.status==='active'){await transaction(async client=>{const db=withClient(client);await db.execute("UPDATE ai_services SET current_deployment_id=$1,status='active',updated_at=NOW() WHERE id=$2",[deploymentId,input.serviceId]);await db.execute("UPDATE ai_service_channels SET active_deployment_id=$1,status='enabled',updated_at=NOW() WHERE service_id=$2 AND channel_type='web_link' AND status<>'blocked'",[deploymentId,input.serviceId]);await db.execute("INSERT INTO ai_service_audit_events(service_id,deployment_id,actor_user_id,event_type,payload) VALUES($1,$2,$3,'service_resume',$4::jsonb)",[input.serviceId,deploymentId,input.actorUserId,JSON.stringify({reason:'one_click_deploy'})])});return}if(row.status==='draft')await submitDeploymentForReview(deploymentId,input.actorUserId,input.serviceId);const afterSubmit=await queryOne<{status:DeploymentStatus}>(`SELECT status FROM ai_service_deployments WHERE id=$1 AND service_id=$2`,[deploymentId,input.serviceId]);if(afterSubmit?.status==='review')await approveDeployment(deploymentId,input.actorUserId,input.serviceId);await recordServerDeployCheck({serviceId:input.serviceId,deploymentId,evaluatedByUserId:input.actorUserId});await activateDeployment(deploymentId,input.actorUserId,'deploy',input.serviceId)}
/** Reactivate a prior approved or superseded version. */ export const rollbackDeployment=(id:string,actor:number,serviceId?:string)=>activateDeployment(id,actor,'rollback',serviceId);

export interface AIServiceRow {
  id:string; name:string; description:string; owner_project_id:string; owner_agent_profile_version:number;
  service_type:string; status:string; owner_user_id:number; maintainers:unknown; current_deployment_id:string|null;
  created_at:string; updated_at:string;
}
export interface AIServiceOverview extends AIServiceRow {
  ownerProjectId:string; ownerProjectRootPath:string|null; ownerAgentName:string; ownerAgentFace:string; ownerAgentProfileVersion:number; serviceType:string; updatedAt:string;
  currentDeployment?:{id:string;version:number;status:string;sourceSnapshot?:unknown;policySnapshot?:unknown;experienceSnapshot?:unknown;evaluationSnapshot?:unknown;deployedAt?:string|null;createdAt?:string}|null;
  latestDeployment?:{id:string;version:number;status:string}|null;
  deployments:Array<{id:string;version:number;status:string;deployedAt:string|null;createdAt:string}>;
  latestEvaluation?:{id:string;status:string;evaluatedAt:string;harnessId:string;harnessVersion:number;runtimeProfileId:string;runtimeProfileVersion:number}|null;
  channels:Array<{id:string;name:string;channelType:string;status:string;accessMode:string;hasPassword:boolean;publicUi:unknown}>;
  metrics:{conversations:number;unresolved:number;cost:number};
}
export interface CreateAIServiceInput { name:string;description?:string;ownerProjectId:string;ownerAgentProfileVersion?:number;serviceType:'customer'|'partner'|'employee'|'public'|'api';ownerUserId:number }
export interface CreateDeploymentInput extends DeploymentSnapshots { serviceId:string;createdByUserId:number }

interface HarnessBindingSnapshot {
  harnessId:string; harnessVersion:number; runtimeProfileId:string; runtimeProfileVersion:number;
  engine:'pi'|'claude'; model?:string; status?:string;
}
function harnessBindingFromPolicy(policySnapshot:unknown):HarnessBindingSnapshot {
  const policy=policySnapshot && typeof policySnapshot==='object' ? policySnapshot as Record<string,unknown> : {};
  const binding=policy.harnessBinding && typeof policy.harnessBinding==='object' ? policy.harnessBinding as Record<string,unknown> : null;
  if(!binding)throw new AIServiceStateError('Published Harness binding required');
  const ref:HarnessBindingSnapshot={
    harnessId:String(binding.harnessId||''), harnessVersion:Number(binding.harnessVersion),
    runtimeProfileId:String(binding.runtimeProfileId||''), runtimeProfileVersion:Number(binding.runtimeProfileVersion),
    engine:binding.engine==='claude'?'claude':'pi', model:typeof binding.model==='string'?binding.model:undefined,
    status:typeof binding.status==='string'?binding.status:undefined,
  };
  if(!ref.harnessId||!Number.isInteger(ref.harnessVersion)||ref.harnessVersion<1||!ref.runtimeProfileId||!Number.isInteger(ref.runtimeProfileVersion)||ref.runtimeProfileVersion<1)throw new AIServiceStateError('Valid published Harness binding required');
  if(ref.status && ref.status!=='published')throw new AIServiceStateError('Only a published Harness can be deployed');
  return ref;
}
async function validateDeploymentPolicy(policySnapshot:unknown):Promise<void>{
  const binding=harnessBindingFromPolicy(policySnapshot);
  const resolved=await resolvePublishedHarnessReference(binding);
  const policy=policySnapshot as Record<string,unknown>;
  if(policy.allowedTools!==undefined){
    if(!Array.isArray(policy.allowedTools)||policy.allowedTools.some(item=>typeof item!=='string'))throw new AIServiceStateError('allowedTools must be derived from the published Harness');
    const expected=resolved.id==='quick-web-research'?['WebFetch','WebSearch']:null;
    if(expected){const actual=[...(policy.allowedTools as string[])].sort();if(JSON.stringify(actual)!==JSON.stringify([...expected].sort()))throw new AIServiceStateError('allowedTools do not match the published Harness');}
  }
}

export async function listAIServicesForUser(userId:number,role:string):Promise<AIServiceOverview[]> {
  const privileged=role==='admin'||role==='operator';
  return query<AIServiceOverview>(`SELECT s.*,
    s.owner_project_id AS "ownerProjectId", p.root_path AS "ownerProjectRootPath", s.service_type AS "serviceType", s.updated_at AS "updatedAt",
    COALESCE(pap.display_name,p.name) AS "ownerAgentName", COALESCE(pap.face,'✨') AS "ownerAgentFace", COALESCE(pap.instruction_version,0) AS "ownerAgentProfileVersion",
    CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object('id',d.id,'version',d.version,'status',d.status,'sourceSnapshot',d.source_snapshot,'policySnapshot',d.policy_snapshot,'experienceSnapshot',d.experience_snapshot,'evaluationSnapshot',d.evaluation_snapshot,'deployedAt',d.deployed_at,'createdAt',d.created_at) END AS "currentDeployment",
    (SELECT jsonb_build_object('id',ld.id,'version',ld.version,'status',ld.status) FROM ai_service_deployments ld WHERE ld.service_id=s.id ORDER BY ld.version DESC LIMIT 1) AS "latestDeployment",
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',vd.id,'version',vd.version,'status',vd.status,'deployedAt',vd.deployed_at,'createdAt',vd.created_at) ORDER BY vd.version DESC) FROM ai_service_deployments vd WHERE vd.service_id=s.id),'[]'::jsonb) AS deployments,
    (SELECT jsonb_build_object('id',e.id,'status',e.status,'evaluatedAt',e.evaluated_at,'harnessId',e.harness_id,'harnessVersion',e.harness_version,'runtimeProfileId',e.runtime_profile_id,'runtimeProfileVersion',e.runtime_profile_version) FROM ai_service_runtime_evaluations e JOIN ai_service_deployments ed ON ed.id=e.deployment_id WHERE ed.service_id=s.id ORDER BY e.evaluated_at DESC LIMIT 1) AS "latestEvaluation",
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'channelType',c.channel_type,'status',c.status,'accessMode',COALESCE(c.config->'publicAccess'->>'mode',c.config->>'accessMode','unlisted'),'hasPassword',(c.config->'publicAccess'->>'passwordHash') IS NOT NULL,'publicUi',COALESCE(c.config->'publicAccess'->'ui','{}'::jsonb)) ORDER BY c.created_at) FROM ai_service_channels c WHERE c.service_id=s.id),'[]'::jsonb) AS channels,
    jsonb_build_object('conversations',(SELECT COUNT(*) FROM ai_service_conversations x WHERE x.service_id=s.id),'unresolved',0,'cost',0) AS metrics
    FROM ai_services s JOIN projects p ON p.id=s.owner_project_id LEFT JOIN project_agent_profiles pap ON pap.project_id=p.id LEFT JOIN ai_service_deployments d ON d.id=s.current_deployment_id
    WHERE s.status<>'retired' AND ($2::boolean OR s.owner_user_id=$1 OR EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=s.owner_project_id AND pm.user_id=$1)) ORDER BY s.updated_at DESC`,[userId,privileged]);
}
export async function getAIServiceForUser(id:string,userId:number,role:string):Promise<AIServiceOverview|null>{return (await listAIServicesForUser(userId,role)).find(s=>s.id===id)||null}

export interface AIServiceConversationSummary {
  id:string; runtimeSessionId:string|null; sessionName:string|null; tenantKey:string; userKey:string;
  status:string; createdAt:string; updatedAt:string; messageCount:number; totalTokens:number;
}
export async function listAIServiceConversations(serviceId:string,limit=50):Promise<AIServiceConversationSummary[]>{
  return query<AIServiceConversationSummary>(`SELECT x.id, x.runtime_session_id AS "runtimeSessionId", ss.name AS "sessionName",
    x.tenant_key AS "tenantKey", x.user_key AS "userKey", x.status,
    x.created_at AS "createdAt", x.updated_at AS "updatedAt",
    (SELECT COUNT(*)::int FROM ai_service_conversation_messages m WHERE m.conversation_id=x.id) AS "messageCount",
    COALESCE((SELECT SUM(COALESCE(tm.input_tokens,0)+COALESCE(tm.output_tokens,0))::bigint FROM messages tm WHERE tm.session_id=ss.id),0)::bigint AS "totalTokens"
    FROM ai_service_conversations x
    LEFT JOIN sessions ss ON ss.id=x.runtime_session_id
    WHERE x.service_id=$1
    ORDER BY x.updated_at DESC
    LIMIT $2`,[serviceId,Math.max(1,Math.min(200,limit))]);
}
export async function assertAIServiceAccess(id:string,userId:number,role:string):Promise<AIServiceRow>{const privileged=role==='admin'||role==='operator';const row=await queryOne<AIServiceRow>(`SELECT s.* FROM ai_services s WHERE s.id=$1 AND ($3::boolean OR s.owner_user_id=$2 OR EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=s.owner_project_id AND pm.user_id=$2))`,[id,userId,privileged]);if(!row)throw new AIServiceStateError('AI service not found or inaccessible');return row}
export async function createAIService(input:CreateAIServiceInput):Promise<AIServiceRow>{const id=uuidv4();const row=await queryOne<AIServiceRow>(`INSERT INTO ai_services(id,name,description,owner_project_id,owner_agent_profile_version,service_type,owner_user_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[id,input.name.trim(),input.description?.trim()||'',input.ownerProjectId,input.ownerAgentProfileVersion??0,input.serviceType,input.ownerUserId]);if(!row)throw new AIServiceStateError('Failed to create AI service');await execute("INSERT INTO ai_service_audit_events(service_id,actor_user_id,event_type) VALUES($1,$2,'service_created')",[id,input.ownerUserId]);return row}
export async function createDeployment(input:CreateDeploymentInput):Promise<{id:string;version:number;status:DeploymentStatus;snapshotHash:string}>{await validateDeploymentPolicy(input.policySnapshot);serviceIdentityFromExperience(input.experienceSnapshot);const snapshots={sourceSnapshot:input.sourceSnapshot,policySnapshot:input.policySnapshot,experienceSnapshot:input.experienceSnapshot,evaluationSnapshot:input.evaluationSnapshot};const hash=deploymentSnapshotHash(snapshots);return transaction(async client=>{const db=withClient(client);const service=await db.queryOne<AIServiceRow>('SELECT * FROM ai_services WHERE id=$1 FOR UPDATE',[input.serviceId]);if(!service)throw new AIServiceStateError('AI service not found');const versionRow=await db.queryOne<{version:number}>('SELECT COALESCE(MAX(version),0)+1 AS version FROM ai_service_deployments WHERE service_id=$1',[input.serviceId]);const version=Number(versionRow?.version||1),id=uuidv4();await db.execute(`INSERT INTO ai_service_deployments(id,service_id,version,source_snapshot,policy_snapshot,experience_snapshot,evaluation_snapshot,snapshot_hash,created_by_user_id) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)`,[id,input.serviceId,version,JSON.stringify(input.sourceSnapshot),JSON.stringify(input.policySnapshot),JSON.stringify(input.experienceSnapshot),JSON.stringify(input.evaluationSnapshot),hash,input.createdByUserId]);await db.execute("INSERT INTO ai_service_audit_events(service_id,deployment_id,actor_user_id,event_type) VALUES($1,$2,$3,'deployment_created')",[input.serviceId,id,input.createdByUserId]);return{id,version,status:'draft',snapshotHash:hash}})}
export async function createWebLinkChannel(serviceId:string,name:string):Promise<{id:string}>{const id=uuidv4();await execute("INSERT INTO ai_service_channels(id,service_id,channel_type,name,status,config) VALUES($1,$2,'web_link',$3,'disabled',$4::jsonb)",[id,serviceId,name,JSON.stringify({publicAccess:{mode:'unlisted'}})]);return{id}}
export async function createServiceConversation(input:{serviceId:string;deploymentId:string;channelId:string;tenantKey:string;userKey:string}):Promise<{id:string}>{const id=uuidv4();await execute('INSERT INTO ai_service_conversations(id,service_id,deployment_id,channel_id,tenant_key,user_key) VALUES($1,$2,$3,$4,$5,$6)',[id,input.serviceId,input.deploymentId,input.channelId,input.tenantKey,input.userKey]);return{id}}
/** Create a serving Conversation only from an enabled Channel's exact active Deployment pointer. */
export async function createActiveChannelConversation(input:{serviceId:string;channelId:string;tenantKey:string;userKey:string}):Promise<{id:string;deploymentId:string}>{
  const id=uuidv4();
  const row=await queryOne<{id:string;deployment_id:string}>(`INSERT INTO ai_service_conversations(id,service_id,deployment_id,channel_id,tenant_key,user_key)
    SELECT $1,c.service_id,c.active_deployment_id,c.id,$3,$4 FROM ai_service_channels c
    JOIN ai_services s ON s.id=c.service_id AND s.status='active' AND s.current_deployment_id=c.active_deployment_id
    JOIN ai_service_deployments d ON d.id=c.active_deployment_id AND d.service_id=c.service_id AND d.status='active'
    WHERE c.id=$2 AND c.service_id=$5 AND c.status='enabled' AND c.active_deployment_id IS NOT NULL
    RETURNING id,deployment_id`,[id,input.channelId,input.tenantKey,input.userKey,input.serviceId]);
  if(!row)throw new AIServiceStateError('AI service Channel is not enabled with an active Deployment');
  return{id:row.id,deploymentId:row.deployment_id};
}
export async function appendServiceMessage(input:{conversationId:string;serviceId:string;deploymentId:string;channelId:string;role:'user'|'assistant'|'system'|'tool';content:unknown}):Promise<string>{const id=uuidv4();await execute('INSERT INTO ai_service_conversation_messages(id,conversation_id,role,content,service_id,deployment_id,channel_id) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)',[id,input.conversationId,input.role,JSON.stringify(input.content),input.serviceId,input.deploymentId,input.channelId]);return id}
