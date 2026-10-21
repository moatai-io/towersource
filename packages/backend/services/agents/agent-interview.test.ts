import {describe,it,expect} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ensureInterview,readInterview,answerInterview,interviewContext} from './agent-interview.js';
import {prepareInitialAgent,buildInitialPreparationContext} from './agent-initial-preparation.js';
describe('creation to interview to new-session continuity',()=>{
 it('preserves approved inputs and shows one-question guidance then injects explicit confirmed answer',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'interview-'));
 try{
 prepareInitialAgent(root,{projectId:'p',profileVersion:1,commandId:'c',approvedCardHash:'h',name:'JEV',role:'JEV 분석',promise:'검증된 판단',instruction:'권한 확대 금지',firstMission:'JEV 이해'});
 const first=buildInitialPreparationContext(root,'p',1);expect(first).toContain('가장 중요한 빈칸 하나');expect(first).toContain('입력이 충분하면 바로 실행');expect(first).toContain('업무를 맡겼거나');
 const state=readInterview(root)!;answerInterview(root,state.questionId,state.revision,'판단 오류를 줄이는 체크리스트를 원합니다.');
 const next=buildInitialPreparationContext(root,'p',1);expect(next).toContain('체크리스트');expect(next).toContain('이미 확인한 내용은 다시 묻지');
 ensureInterview(root,'late-result');expect(readInterview(root)?.status).toBe('answered');
 expect(()=>answerInterview(root,state.questionId,state.revision,'late answer')).toThrow();
 }finally{fs.rmSync(root,{recursive:true,force:true});}
 });
 it('skip prevents repeated onboarding and lock protects concurrent edits',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'interview-'));
 try{ensureInterview(root,'x');const s=readInterview(root)!;fs.writeFileSync(path.join(root,'.tower-interview.json.lock'),'');expect(()=>answerInterview(root,s.questionId,1,'x')).toThrow();fs.unlinkSync(path.join(root,'.tower-interview.json.lock'));answerInterview(root,s.questionId,1,null);expect(interviewContext(root)).toContain('반복하지');}finally{fs.rmSync(root,{recursive:true,force:true});}
 });
});
