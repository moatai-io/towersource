import {it,expect,vi} from 'vitest';
const row={status:'running',lease_until:new Date(Date.now()+60000),question_id:'q'};
const calls:any[]=[];let human=false;
vi.mock('../../db/pg-repo.js',()=>({queryOne:vi.fn(),execute:vi.fn(),transaction:async(fn:any)=>fn({query:async(sql:string,args:any[])=>{calls.push([sql,args]);if(sql.includes('FROM agent_initial'))return {rows:[row]};if(sql.includes('FROM messages'))return {rows:human?[{}]:[]};return {rows:[]};}})}));
import {parseFirstInterview,commitInterviewArtifact,answerDurableInterview} from './durable-interview.js';
it('commits actual assistant artifact and real question id, not just turn completion',async()=>{calls.length=0;human=false;row.status='running';expect(await commitInterviewArtifact('s',JSON.stringify({greeting:'안내',question:'목표 결과물은 무엇인가요?',plan:null}),'m')).toBe(true);expect(calls.some(([s])=>s.includes('INSERT INTO messages'))).toBe(true);});
it('late output is rejected when user started',async()=>{human=true;calls.length=0;expect(await commitInterviewArtifact('s',JSON.stringify({greeting:'안내',question:'질문',plan:null}),'late')).toBe(false);expect(calls.some(([s])=>s.includes('INSERT INTO messages'))).toBe(false);});
it('structured question answer records user evidence atomically',async()=>{human=false;row.status='awaiting';calls.length=0;await answerDurableInterview('p','s','q','체크리스트');expect(calls.some(([s,a])=>s.includes('INSERT INTO messages')&&a[3].includes('replyToQuestionId'))).toBe(true);});
it('invalid model artifact cannot establish an answer',()=>{expect(()=>parseFirstInterview('{"answer":"확정"}')).toThrow();});
