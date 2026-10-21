import {it,expect} from 'vitest';import fs from 'node:fs';
it('production automatic turn reaches handleChat engine.run with tool isolation and guarded artifact commit',()=>{
 const read=(p:string)=>fs.readFileSync(p,'utf8');const create=read('packages/backend/services/agents/primary-agent-creation.ts'),dispatch=read('packages/backend/services/agents/automatic-interview.ts'),ws=read('packages/backend/routes/ws-handler.ts');
 expect(create).toContain('scheduleDurableInterview(project.id, interviewSession.id');expect(dispatch).toContain('startInitialInterview(claim.session_id,claim.actor_user_id,claim.token)');
 const entry=ws.slice(ws.indexOf('export async function startInitialInterview'));expect(entry).toContain('await handleChat(');expect(entry).toContain('initialInterview:true');expect(entry).toContain("session?.engine !== 'pi'");
 expect(ws).toContain('initialInterview: data.initialInterview');expect(ws).toContain('engine.run(sessionId, finalMessage, runOpts, callbacks)');expect(ws).toContain('commitInterviewArtifact(sessionId,text,msg.id,data.initialInterviewToken)');expect(ws).toContain("if (!data.initialInterview || ['result','error'].includes(towerMsg.type))");
 expect(read('packages/backend/engines/pi/tool-assembly.ts')).toContain('if (opts.initialInterview) return');expect(read('packages/backend/engines/pi-engine.ts')).toContain('Math.min(resolvedSessionModel.maxTokens,1024)');
});
