import { Type } from '@sinclair/typebox';
import { search } from '../../services/workspace/search.js';
import { secretaryReadableSession } from '../../services/secretariat/search-access.js';
import { createSessionTranscriptReadTool } from '../pi-session-transcript-tool.js';
export function secretaryReadingTools(userId:number,onSource:(source:{projectId:string;sessionId:string})=>void) {
 let calls=0;
 const result=(data:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(data)}],details:{}});
 const transcript=createSessionTranscriptReadTool({userId,userRole:'member',modelContextWindow:16000});
 return [{name:'conversation_search',label:'참여 대화 검색',description:'Search your participating authorized conversations. Read-only, limited results; no filesystem access.',parameters:Type.Object({query:Type.String({minLength:2,maxLength:200})}),
 execute:async(_id:string,p:{query:string})=>{
  if(++calls>4)return result({error:'reading_budget_exhausted'});
  const hits=await search(p.query,{userId,role:'member',limit:20,sessionLimit:10,messageLimit:10,memoryLimit:0,workLimit:0,includeArchived:false});
  const accepted=[];
  for(const hit of hits){const source=await secretaryReadableSession(userId,hit.sessionId);if(!source)continue;onSource(source);accepted.push({sessionId:hit.sessionId,title:hit.sessionName,project:hit.projectName,snippet:hit.snippet.slice(0,1200)});if(accepted.length>=8)break;}
  return result({hits:accepted,partial:true,note:'Bounded search filtered to participating sessions; absence is not proof of no records.'});
 }}, {name:'session_transcript_read',label:'참여 대화 읽기',description:'Read visible messages of one authorized participating session.',parameters:Type.Object({session_id:Type.String({maxLength:100})}),
 execute:async(id:string,p:{session_id:string},signal?:AbortSignal)=>{
  if(++calls>4)return result({error:'reading_budget_exhausted'});
  const source=await secretaryReadableSession(userId,p.session_id);if(!source)return result({error:'not_accessible_or_not_participating'});
  onSource(source);
  return transcript.execute(id,{session_id:p.session_id,limit:30},signal,undefined,{} as any);
 }}];
}
