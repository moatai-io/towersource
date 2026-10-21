import { registerAgentTurn } from '../agent-turn/turn-supervisor.js';
import {queryOne,execute} from '../../db/pg-repo.js';
import {getSession, claimEngineSessionId} from '../session/session-manager.js';
import type {EngineCallbacks} from '../../engines/types.js';
import {getEngine} from '../../engines/index.js';
import {resolveHarnessForSession} from '../harness/harness-resolver.js';
import {commitInterviewArtifact} from './durable-interview.js';
import {randomUUID} from 'node:crypto';
/** Narrow server-origin turn using existing engine/Harness boundaries, not the user-chat pipeline. */
export async function executeInitialInterviewTurn(sessionId:string,token:string,userId:number):Promise<void>{
 const claim=await queryOne<any>("SELECT * FROM agent_initial_interviews WHERE session_id=$1 AND token=$2 AND status='running'",[sessionId,token]);if(!claim)return;
 const human=await queryOne<any>("SELECT 1 FROM messages WHERE session_id=$1 AND role='user' LIMIT 1",[sessionId]);if(human)return;
 const session=await getSession(sessionId);if(!session||session.engine!=='pi')throw new Error('Initial interview requires Pi');
 const harness=await resolveHarnessForSession({sessionId,projectId:session.projectId??undefined,requestedEngine:'pi'});
 const engine=await getEngine('pi');const id=randomUUID();
 const timer=setTimeout(()=>{void engine.abort(sessionId);},60000);
 try{
 await execute("INSERT INTO messages(id,session_id,role,content,metadata) VALUES($1,$2,'system',$3,$4::jsonb)",[id,sessionId,JSON.stringify([{type:'text',text:'생성 후 자동 첫 안내 시작'}]),JSON.stringify({origin:'agent-initial-interview'})]);
 await registerAgentTurn({rootTurnId:id,sessionId});
 const prompt='생성 입력을 이해하고 안내와 가장 중요한 질문 하나를 작성하세요. 충분하면 질문 없이 실행안을 작성하세요. 외부 조회·도구·실제 업무 실행 금지. 추정은 가설로 표시하세요. 출력은 JSON만: {"greeting":"안내","question":null,"plan":"실행안"}. 질문이 필요하면 question에 질문을 넣고 plan은 null로 하세요.';
 let savedMessageId:string|undefined;let reason='INITIAL_EMPTY_RESPONSE';
 const pending=new Map<string,string>();
 let outcomePromise:Promise<{savedMessageId?:string;reason?:string}>|undefined;
 const persist=async(id:string,text:string)=>{if(savedMessageId)return;try{if(await commitInterviewArtifact(sessionId,text,id,token)){savedMessageId=id;reason='';}else reason='INITIAL_CLAIM_REJECTED';}catch{reason=text.trim()?'INITIAL_INVALID_ARTIFACT':'INITIAL_EMPTY_RESPONSE';}};
 const callbacks: EngineCallbacks = {
 initialArtifactOutcome:()=>outcomePromise ??= (async()=>{for(const [id,text] of pending)await persist(id,text);return {savedMessageId,reason};})(),
 askUser:async()=>{throw new Error('Initial interview cannot wait for a tool question');},
 claimSessionId:async(id)=>{await claimEngineSessionId(sessionId,'pi',id);},
 saveMessage:async(msg)=>{if(msg.role!=='assistant')return;pending.set(msg.id,msg.content.filter(b=>b.type==='text').map(b=>b.text).join(''));},
 updateMessageContent:async(id,content)=>{pending.set(id,content.filter(b=>b.type==='text').map(b=>b.text).join(''));},attachToolResult:async()=>{},updateMessageMetrics:async()=>{},
 };
 for await(const _ of engine.run(sessionId,prompt,{rootTurnId:id,cwd:session.cwd,projectId:session.projectId??undefined,userId,initialInterview:true,harnessId:harness.id,harnessVersion:harness.version,runtimeProfileId:harness.runtimeProfileId,runtimeProfileVersion:harness.runtimeProfileVersion}, callbacks)){/* Never expose intermediate structured output. Stored artifact is authoritative. */}
 }finally{clearTimeout(timer);}
}
