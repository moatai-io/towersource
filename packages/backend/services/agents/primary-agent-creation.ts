/**
 * Owns: idempotent Primary Agent creation orchestration across Project, profile, Harness binding, files, and first Session.
 * Public API: createPrimaryAgentCommand.
 */
import { createHash } from 'node:crypto';
import { getPgPool } from '../../db/pg.js';
import { queryOne, execute, transaction, withClient } from '../../db/pg-repo.js';
import { createProject, getProject } from '../pm/project-manager.js';
import { ensureProjectAgentInstruction } from '../pm/project-agent-instruction.js';
import { createSession, getSession } from '../session/session-manager.js';
import { consumePrimaryAgentCreationIntent } from './primary-agent-creation-intent.js';
import type { PrimaryAgentCapabilityRequirements } from './primary-agent-staffing.js';
import { validatePrimaryAgentHarnessBinding } from './primary-agent-staffing.js';
import { ensurePrimaryAgentOnboardingDocument } from './primary-agent-onboarding.js';

export interface PrimaryAgentCreationInput {
  idempotencyKey:string;actorUserId:number;sourceProjectId:string;approvedCardHash:string;approvalIntentId:string;
  name:string;description?:string;face:string;tagline:string;role:string;promise:string;instruction:string;firstMission:string;
  authorityPolicy?:Record<string,unknown>;toolPolicy?:Record<string,unknown>;
  roiContract?:{primaryMetric:string;baseline?:string;target:string;confidence?:'low'|'medium'|'high';reviewAfterDays?:number};
  capabilityRequirements:PrimaryAgentCapabilityRequirements;
  harnessBinding:{harnessId:string;harnessVersion:number;runtimeProfileId:string;runtimeProfileVersion:number};
  creationMode?:'bootstrap'|'staffed';sourceExpertiseIntent?:string;
}

function stable(value:unknown):string {
  if(Array.isArray(value))return`[${value.map(stable).join(',')}]`;
  if(value&&typeof value==='object')return`{${Object.entries(value as Record<string,unknown>).filter(([,item])=>item!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value:unknown){return createHash('sha256').update(stable(value)).digest('hex')}
/** Display names may use any language; filesystem/API identity is always a deterministic ASCII slug. */
function primaryAgentProjectSlug(commandId:string){return `agent-${commandId.replace(/-/g,'').toLowerCase().slice(0,12)}`}
function sameJson(left:unknown,right:unknown){return stable(left??{})===stable(right??{})}
function assertEqual(actual:unknown,expected:unknown,label:string){if(actual!==expected)throw new Error(`Primary Agent resume conflict: ${label} does not match the approved command`)}
function autoNameableSessionTitle(){return `Session ${new Date().toLocaleString('en-US')}`}
async function event(commandId:string,type:string,payload:unknown={}){await execute('INSERT INTO primary_agent_creation_events(command_id,event_type,payload) VALUES($1,$2,$3::jsonb)',[commandId,type,JSON.stringify(payload)])}
async function state(id:string,status:string,patch:{projectId?:string;sessionId?:string;error?:string;result?:unknown}={}){
  const terminal=status==='ready'||status==='failed';
  await execute(`UPDATE primary_agent_creation_commands SET status=$2,project_id=COALESCE($3,project_id),session_id=COALESCE($4,session_id),error=$5,result=COALESCE($6::jsonb,result),attempt_count=attempt_count+1,updated_at=NOW(),finished_at=CASE WHEN $7 THEN NOW() ELSE finished_at END WHERE id=$1 AND (status<>'ready' OR $2='ready')`,[id,status,patch.projectId||null,patch.sessionId||null,patch.error||null,patch.result===undefined?null:JSON.stringify(patch.result),terminal])
}

async function reserveCommandAndConsumeIntent(input:PrimaryAgentCreationInput,requestHash:string){
  return transaction(async client=>{
    const db=withClient(client);
    const inserted=await db.queryOne<any>(`INSERT INTO primary_agent_creation_commands(actor_user_id,source_project_id,idempotency_key,request_hash,approved_card_hash,harness_id,harness_version,runtime_profile_id,runtime_profile_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(actor_user_id,idempotency_key) DO NOTHING RETURNING *`,
    [input.actorUserId,input.sourceProjectId,input.idempotencyKey,requestHash,input.approvedCardHash,input.harnessBinding.harnessId,input.harnessBinding.harnessVersion,input.harnessBinding.runtimeProfileId,input.harnessBinding.runtimeProfileVersion]);
    const command=inserted||await db.queryOne<any>('SELECT * FROM primary_agent_creation_commands WHERE actor_user_id=$1 AND idempotency_key=$2',[input.actorUserId,input.idempotencyKey]);
    if(!command)throw new Error('Primary Agent command reservation failed');
    if(command.request_hash!==requestHash)throw new Error('Idempotency key already used with a different request');
    await consumePrimaryAgentCreationIntent({approvalIntentId:input.approvalIntentId,commandId:command.id,actorUserId:input.actorUserId,sourceProjectId:input.sourceProjectId,approvedCardHash:input.approvedCardHash,payload:{name:input.name,description:input.description,face:input.face,tagline:input.tagline,role:input.role,promise:input.promise,instruction:input.instruction,firstMission:input.firstMission,authorityPolicy:input.authorityPolicy,toolPolicy:input.toolPolicy,roiContract:input.roiContract,capabilityRequirements:input.capabilityRequirements,harnessBinding:input.harnessBinding,creationMode:input.creationMode,sourceExpertiseIntent:input.sourceExpertiseIntent},db});
    if(inserted)await db.execute('INSERT INTO primary_agent_creation_events(command_id,event_type,payload) VALUES($1,$2,$3::jsonb)',[command.id,'command_reserved',JSON.stringify({requestHash})]);
    return command;
  });
}

async function withCommandLock<T>(actorUserId:number,idempotencyKey:string,fn:()=>Promise<T>):Promise<T>{
  const client=await getPgPool().connect();
  const key=`primary-agent:${actorUserId}:${idempotencyKey}`;
  try{
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);
    return await fn();
  }finally{
    try{await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key])}finally{client.release()}
  }
}

async function assertProfile(projectId:string,input:PrimaryAgentCreationInput,commandId:string){
  const row=await queryOne<any>('SELECT * FROM project_agent_profiles WHERE project_id=$1',[projectId]);
  if(!row)throw new Error('Primary Agent profile provisioning failed');
  assertEqual(row.display_name,input.name.trim(),'Profile display name');
  assertEqual(row.face,input.face.trim(),'Profile face');
  assertEqual(row.tagline,input.tagline.trim(),'Profile tagline');
  assertEqual(row.role,input.role.trim(),'Profile role');
  assertEqual(row.promise,input.promise.trim(),'Profile promise');
  assertEqual(row.instruction,input.instruction.trim(),'Profile instruction');
  assertEqual(row.onboarding_state,input.creationMode==='bootstrap'?'onboarding':'ready','Profile onboarding state');
  if(!sameJson(row.authority_policy,input.authorityPolicy||{}))throw new Error('Primary Agent resume conflict: authority policy does not match the approved command');
  if(!sameJson(row.tool_policy,input.toolPolicy||{}))throw new Error('Primary Agent resume conflict: tool policy does not match the approved command');
  assertEqual(row.metadata?.creationCommandId,commandId,'Profile creation command');
}

async function ensureBinding(projectId:string,input:PrimaryAgentCreationInput,commandId:string){
  const binding=input.harnessBinding;
  await validatePrimaryAgentHarnessBinding({sourceProjectId:input.sourceProjectId,binding,requirements:input.capabilityRequirements});
  await execute(`INSERT INTO agent_harness_binding_revisions(project_id,revision,harness_id,harness_version,runtime_profile_id,runtime_profile_version,state,reason,command_id,bound_by_user_id) VALUES($1,1,$2,$3,$4,$5,'active','agent-create',$6,$7) ON CONFLICT(project_id,revision) DO NOTHING`,[projectId,binding.harnessId,binding.harnessVersion,binding.runtimeProfileId,binding.runtimeProfileVersion,commandId,input.actorUserId]);
  await execute(`INSERT INTO project_agent_harness_bindings(project_id,harness_id,harness_version,runtime_profile_id,runtime_profile_version,current_revision,bound_by_user_id) VALUES($1,$2,$3,$4,$5,1,$6) ON CONFLICT(project_id) DO NOTHING`,[projectId,binding.harnessId,binding.harnessVersion,binding.runtimeProfileId,binding.runtimeProfileVersion,input.actorUserId]);
  const revision=await queryOne<any>('SELECT * FROM agent_harness_binding_revisions WHERE project_id=$1 AND revision=1',[projectId]);
  const current=await queryOne<any>('SELECT * FROM project_agent_harness_bindings WHERE project_id=$1',[projectId]);
  for(const row of [revision,current]){
    if(!row)throw new Error('Primary Agent Harness binding provisioning failed');
    assertEqual(row.harness_id,binding.harnessId,'Harness id');assertEqual(Number(row.harness_version),binding.harnessVersion,'Harness version');
    assertEqual(row.runtime_profile_id,binding.runtimeProfileId,'Runtime Profile id');assertEqual(Number(row.runtime_profile_version),binding.runtimeProfileVersion,'Runtime Profile version');
  }
  assertEqual(revision.command_id,commandId,'Harness revision creation command');
  assertEqual(Number(current.current_revision),1,'Current Harness revision');
  return {harnessId:current.harness_id,harnessVersion:Number(current.harness_version),runtimeProfileId:current.runtime_profile_id,runtimeProfileVersion:Number(current.runtime_profile_version)};
}

/** Run or safely resume one server-approved Primary Agent creation command. */
export async function createPrimaryAgentCommand(input:PrimaryAgentCreationInput){
  const requestHash=hash({...input,idempotencyKey:undefined});
  return withCommandLock(input.actorUserId,input.idempotencyKey,async()=>{
    let command=await reserveCommandAndConsumeIntent(input,requestHash);
    if(command.status==='ready'&&command.result)return command.result;
    try{
      await state(command.id,'provisioning_project');
      const project=command.project_id?await getProject(command.project_id):await createProject(input.name.trim(),input.actorUserId,{description:input.description?.trim()||input.tagline.trim(),creationCommandId:command.id,slug:primaryAgentProjectSlug(command.id)});
      if(!project)throw new Error('Project provisioning failed');
      const projectProvenance=await queryOne<{creation_command_id:string|null}>('SELECT creation_command_id FROM projects WHERE id=$1',[project.id]);
      assertEqual(projectProvenance?.creation_command_id,command.id,'Project creation command');
      await state(command.id,'provisioning_profile',{projectId:project.id});
      const bootstrap=input.creationMode==='bootstrap';
      const profileMetadata={creationCommandId:command.id,sourceProjectId:input.sourceProjectId,creationMode:bootstrap?'bootstrap':'staffed',...(bootstrap?{sourceExpertiseIntent:input.sourceExpertiseIntent,starterHarness:true,onboardingStartedAt:new Date().toISOString()}: {})};
      await execute(`INSERT INTO project_agent_profiles(project_id,display_name,face,tagline,role,promise,instruction,instruction_source,default_engine,authority_policy,tool_policy,memory_policy,budget_policy,onboarding_state,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,'employee-card','pi',$8::jsonb,$9::jsonb,'{}'::jsonb,'{}'::jsonb,$10,$11::jsonb) ON CONFLICT(project_id) DO NOTHING`,[project.id,input.name.trim(),input.face.trim(),input.tagline.trim(),input.role.trim(),input.promise.trim(),input.instruction.trim(),JSON.stringify(input.authorityPolicy||{}),JSON.stringify(input.toolPolicy||{}),bootstrap?'onboarding':'ready',JSON.stringify(profileMetadata)]);
      await assertProfile(project.id,input,command.id);
      if(bootstrap)await event(command.id,'onboarding_started',{expertiseIntent:input.sourceExpertiseIntent});
      await state(command.id,'binding_harness',{projectId:project.id});
      const actualBinding=await ensureBinding(project.id,input,command.id);
      await state(command.id,'provisioning_files',{projectId:project.id});
      ensureProjectAgentInstruction(project.rootPath!,{displayName:input.name,face:input.face,tagline:input.tagline,role:input.role,promise:input.promise,instruction:input.instruction});
      if(bootstrap){
        const expectedExpertise=input.sourceExpertiseIntent?.trim();
        if(!expectedExpertise)throw new Error('Bootstrap Primary Agent requires source expertise intent');
        ensurePrimaryAgentOnboardingDocument(project.rootPath!,{name:input.name,expectedExpertise});
      }
      await state(command.id,'creating_session',{projectId:project.id});
      command=await queryOne<any>('SELECT * FROM primary_agent_creation_commands WHERE id=$1',[command.id]);
      let session=command?.session_id?await getSession(command.session_id,input.actorUserId):null;
      if(!session){const existing=await queryOne<{id:string}>('SELECT id FROM sessions WHERE agent_creation_command_id=$1',[command.id]);session=existing?await getSession(existing.id,input.actorUserId):null}
      if(!session)session=await createSession(autoNameableSessionTitle(),project.rootPath!,input.actorUserId,project.id,'pi',null,null,null,undefined,null,{visibility:'project',agentCreationCommandId:command.id});
      assertEqual(session.projectId,project.id,'Session Project');assertEqual(session.visibility,'project','Session visibility');
      const sessionProvenance=await queryOne<{agent_creation_command_id:string|null}>('SELECT agent_creation_command_id FROM sessions WHERE id=$1',[session.id]);
      assertEqual(sessionProvenance?.agent_creation_command_id,command.id,'Session creation command');
      const hydratedProject=await getProject(project.id);
      if(!hydratedProject)throw new Error('Primary Agent Project hydration failed');
      const result={ok:true,commandId:command.id,project:hydratedProject,session:{...session,visibility:'project'},harnessBinding:actualBinding};
      await state(command.id,'ready',{projectId:project.id,sessionId:session.id,result});await event(command.id,'command_ready',{projectId:project.id,sessionId:session.id});return result;
    }catch(error){const message=error instanceof Error?error.message:String(error);await state(command.id,'failed',{error:message});await event(command.id,'command_failed',{error:message});throw error}
  });
}
